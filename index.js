/**
 * TellusCN Cloudflare Workers 反代服务
 * 
 * 为 Tellus Minecraft Mod 提供国内加速的数据源代理
 * 支持高程数据、地表覆盖、天气、地理编码等所有数据源
 */

// 数据源配置映射
const DATA_SOURCES = {
  // 高程数据 - Terrarium
  'elevation': {
    target: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium',
    cacheTtl: 86400 * 30, // 30天缓存，高程数据基本不变
  },
  
  // Copernicus DEM 30m
  'copernicus30': {
    target: 'https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com',
    cacheTtl: 86400 * 30,
  },
  
  // Copernicus DEM 90m
  'copernicus90': {
    target: 'https://copernicus-dem-90m.s3.eu-central-1.amazonaws.com',
    cacheTtl: 86400 * 30,
  },
  
  // USGS 3DEP
  'usgs': {
    target: 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer',
    cacheTtl: 86400 * 7, // 7天缓存
  },
  
  // Japan GSI
  'japangsi': {
    target: 'https://cyberjapandata.gsi.go.jp/xyz',
    cacheTtl: 86400 * 30,
  },
  
  // ArcticDEM
  'arcticdem': {
    target: 'https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/arcticdem/mosaics/v4.1',
    cacheTtl: 86400 * 30,
  },
  
  // REMA (南极)
  'rema': {
    target: 'https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/rema/mosaics/v2.0',
    cacheTtl: 86400 * 30,
  },
  
  // 地表覆盖 - ESA WorldCover
  'landcover': {
    target: 'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map',
    cacheTtl: 86400 * 30,
  },
  
  // 天气数据 - Open-Meteo
  'weather': {
    target: 'https://api.open-meteo.com/v1',
    cacheTtl: 3600, // 1小时缓存，天气数据变化较快
  },
  
  // 地理编码 - Nominatim
  'geocoding': {
    target: 'https://nominatim.openstreetmap.org',
    cacheTtl: 86400 * 7, // 7天缓存
  },
  
  // OSM Overpass
  'overpass': {
    target: 'https://overpass-api.de/api',
    cacheTtl: 3600, // 1小时缓存
  },
  
  // Land Mask
  'landmask': {
    target: 'https://github.com/Yucareux/Tellus-Land-Polygons/releases/download/v1.0.0',
    cacheTtl: 86400 * 30,
  },
  
  // 通用 S3 反代（用于 ArcticDEM 等动态 S3 URL）
  's3': {
    target: 'https://s3.us-west-2.amazonaws.com',
    cacheTtl: 86400 * 30,
  },
  
  // OpenStreetMap 地图瓦片
  'tiles': {
    target: 'https://tile.openstreetmap.org',
    cacheTtl: 86400 * 7, // 7天缓存，地图瓦片变化不频繁
    headers: {
      'User-Agent': 'TellusCN-Workers/1.0 (Minecraft Mod Mirror)',
    },
  },
  
  // Overture Maps - Roads (transportation.pmtiles)
  // Java 请求: /overture/roads -> 映射到 /transportation.pmtiles
  'overture/roads': {
    target: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-02-18.0/transportation.pmtiles',
    cacheTtl: 86400 * 30, // 30天缓存
    rewritePath: true, // 标记需要重写路径
  },
  
  // Overture Maps - Buildings
  'overture/buildings': {
    target: 'https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/2026-02-18.0/buildings.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
  
  // Overture Maps - Water (base.pmtiles)
  'overture/water': {
    target: 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2026-01-21/base.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
  
  // Overture Maps - Sand (base.pmtiles，与 water 相同文件)
  'overture/sand': {
    target: 'https://overturemaps-tiles-us-west-2-beta.s3.amazonaws.com/2026-01-21/base.pmtiles',
    cacheTtl: 86400 * 30,
    rewritePath: true,
  },
};

// CORS 响应头
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
};

/**
 * 主入口
 */
export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }
    
    // 只处理 GET 和 HEAD 请求
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method Not Allowed', { 
        status: 405,
        headers: CORS_HEADERS,
      });
    }
    
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      
      // 健康检查端点
      if (path === '/health' || path === '/') {
        return new Response(JSON.stringify({
          status: 'ok',
          service: 'TellusCN Cloudflare Workers',
          version: '1.0.0',
          timestamp: new Date().toISOString(),
          sources: Object.keys(DATA_SOURCES),
        }), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            ...CORS_HEADERS,
          },
        });
      }
      
      // 解析路由 /:source/*
      const pathParts = path.split('/').filter(p => p);
      if (pathParts.length < 1) {
        return new Response('Not Found: Please use /{source}/* format', { 
          status: 404,
          headers: CORS_HEADERS,
        });
      }
      
      // 尝试匹配多级路由（如 overture/roads）
      let sourceKey = pathParts[0];
      let sourceConfig = DATA_SOURCES[sourceKey];
      
      // 如果一级路由不匹配，尝试二级路由（如 overture/roads）
      if (!sourceConfig && pathParts.length >= 2) {
        const multiLevelKey = pathParts[0] + '/' + pathParts[1];
        if (DATA_SOURCES[multiLevelKey]) {
          sourceKey = multiLevelKey;
          sourceConfig = DATA_SOURCES[multiLevelKey];
        }
      }
      
      if (!sourceConfig) {
        return new Response(`Unknown data source: ${sourceKey}. Available: ${Object.keys(DATA_SOURCES).join(', ')}`, {
          status: 404,
          headers: CORS_HEADERS,
        });
      }
      
      // 获取 Range 请求头（用于断点续传和缓存键）
      const rangeHeader = request.headers.get('Range');
      
      // 构建目标 URL
      let targetUrl;
      if (sourceConfig.rewritePath) {
        // 对于 Overture Maps 等单文件数据源，直接使用 target 作为完整 URL
        // 忽略请求路径，因为 Java 端会直接使用返回的 URL
        targetUrl = sourceConfig.target + url.search;
      } else {
        // 正常情况：target + 请求路径
        // 计算路径偏移量（多级路由如 overture/roads 需要跳过两个部分）
        const pathOffset = sourceKey.includes('/') ? 2 : 1;
        const targetPath = '/' + pathParts.slice(pathOffset).join('/');
        targetUrl = sourceConfig.target + targetPath + url.search;
      }
      
      // 创建缓存键（包含 Range 头，确保不同范围请求有独立缓存）
      const cacheKeyUrl = targetUrl + (rangeHeader ? `#range=${rangeHeader}` : '');
      const cacheKey = new Request(cacheKeyUrl, request);
      const cache = caches.default;
      
      // 尝试从缓存获取
      let response = await cache.match(cacheKey);
      
      if (response) {
        // 添加缓存命中标记
        const cachedResponse = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        cachedResponse.headers.set('X-Cache', 'HIT');
        cachedResponse.headers.set('X-Cache-Source', sourceKey);
        return addCorsHeaders(cachedResponse);
      }
      
      // 从源站获取
      const fetchOptions = {
        method: request.method,
        headers: {
          'User-Agent': 'TellusCN-Cloudflare-Workers/1.0 (Minecraft Mod Proxy)',
          'Accept': request.headers.get('Accept') || '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
        },
      };
      
      // 应用数据源自定义 headers（如 tiles 的 User-Agent）
      if (sourceConfig.headers) {
        Object.entries(sourceConfig.headers).forEach(([key, value]) => {
          fetchOptions.headers[key] = value;
        });
      }
      
      // 转发 Range 请求头
      if (rangeHeader) {
        fetchOptions.headers['Range'] = rangeHeader;
      }
      
      // 发送请求到源站
      response = await fetch(targetUrl, fetchOptions);
      
      // 如果源站返回错误，直接返回
      if (!response.ok && response.status !== 206) { // 206 是 Partial Content
        console.error(`Source error: ${response.status} for ${targetUrl}`);
        return new Response(`Source Error: ${response.status}`, {
          status: response.status,
          headers: CORS_HEADERS,
        });
      }
      
      // 创建可缓存的响应
      const responseToCache = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          ...Object.fromEntries(response.headers),
          'X-Cache': 'MISS',
          'X-Cache-Source': sourceKey,
          'X-Proxy-By': 'TellusCN-Cloudflare-Workers',
        },
      });
      
      // 设置缓存控制头
      responseToCache.headers.set('Cache-Control', `public, max-age=${sourceConfig.cacheTtl}`);
      
      // 存入 Cloudflare 缓存
      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
      
      return addCorsHeaders(responseToCache);
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};

/**
 * 添加 CORS 响应头
 */
function addCorsHeaders(response) {
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
