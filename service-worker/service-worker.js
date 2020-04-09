import { ExpirationPlugin } from 'workbox-expiration'
import { registerRoute } from 'workbox-routing'
import { CacheOnly, NetworkOnly, NetworkFirst } from 'workbox-strategies'
import { skipWaiting, clientsClaim } from 'workbox-core'
import { precacheAndRoute, getCacheKeyForURL } from 'workbox-precaching'
import { IS_AMP_REGEX } from './environment'
import { resumePrefetches, abortPrefetches, prefetch } from './prefetch'
import { offlineResponse } from './offline'
import { getAPICacheName } from './cache'

console.log('[react-storefront service worker]', 'Using React Storefront Service Worker')

let runtimeCacheOptions = {}

/**
 * Configures parameters for cached routes.
 * @param {Object} options
 * @param {Object} options.maxEntries The max number of entries to store in the cache
 * @param {Object} options.maxAgeSeconds The TTL in seconds for entries
 */
function configureRuntimeCaching({ maxEntries = 200, maxAgeSeconds = 60 * 60 * 24 } = {}) {
  console.log(
    `[react-storefront service worker] configureRuntimeCaching, maxEntries: ${maxEntries}, maxAgeSeconds: ${maxAgeSeconds}`,
  )

  runtimeCacheOptions = {
    plugins: [
      new ExpirationPlugin({
        maxEntries,
        maxAgeSeconds,
      }),
    ],
  }
}

configureRuntimeCaching()

// provide the message interface that allows the PWA to prefetch
// and cache resources.
self.addEventListener('message', function(event) {
  if (event.data && event.data.action) {
    const { action } = event.data

    if (action === 'cache-path') {
      prefetch(event.data)
    } else if (action === 'cache-state') {
      cacheState(event.data)
    } else if (action === 'configure-runtime-caching') {
      configureRuntimeCaching(event.data.options)
    } else if (action === 'abort-prefetches') {
      abortPrefetches()
    } else if (action === 'resume-prefetches') {
      resumePrefetches()
    }
  }
})

self.addEventListener('install', event => {
  // Deletes all runtime caches except the one for the current api version
  // We do this since we create a new versioned cache name every time we release
  // a new version of the app.  So if we didn't delete the old ones, we would just keep
  // using up local storage
  caches.keys().then(keys => {
    for (let key of keys) {
      if (!key.startsWith('workbox-precache')) caches.delete(key)
    }
  })

  // Cache non-amp version of pages when users land on AMP page
  clients
    .matchAll({
      includeUncontrolled: true,
    })
    .then(allClients => {
      allClients
        .filter(path => path.url.match(IS_AMP_REGEX))
        .map(path => {
          const url = new URL(path.url)
          // remove "amp=1" from anywhere in url.search:
          const fixedSearch = (url.search || '').replace(IS_AMP_REGEX, '$2').replace(/^&/, '?')
          return url.pathname + fixedSearch
        })
        .forEach(path => cachePath({ path }, true))
    })
})

// Catches all non-prefetch requests and aborts in-progress prefetches
// until the request finishes, then resumes prefetching
// self.addEventListener('fetch', event => {
//   abortPrefetches()

//   event.respondWith(
//     (async function() {
//       try {
//         const cacheResponse = await caches.match(event.request)

//         if (cacheResponse) {
//           return cacheResponse
//         }

//         const preCacheResponse = await caches.match(getCacheKeyForURL(event.request.url) || {})

//         if (preCacheResponse) {
//           return preCacheResponse
//         }

//         return await fetch(event.request)
//       } finally {
//         resumePrefetches()
//       }
//     })(),
//   )
// })

/**
 * Returns true if the URL uses https
 * @param {Object} context
 * @return {Boolean}
 */
function isSecure(context) {
  return context.url.protocol === 'https:' || context.url.hostname === 'localhost'
}

/**
 * Returns true if the URL is for a static asset like a js chunk
 * @param {Object} context
 * @return {Boolean}
 */
function isStaticAsset(context) {
  return context.url.pathname.startsWith('/_next/static/')
}

/**
 * Returns true if the URL is for an amp page
 * @param {URL} url
 * @return {Boolean}
 */
function isAmp(url) {
  return !!(url.search || '').match(IS_AMP_REGEX)
}

/**
 * Returns true of the request is for a video file
 * @param {Object} context
 * @return {Boolean}
 */
function isVideo(context) {
  return !!context.url.pathname.match(/\.mp4(\?.*)?$/)
}

const matchRuntimePath = context => {
  return (
    isSecure(context) /* non secure requests will fail */ &&
    !isStaticAsset(context) /* let precache routes handle those */ &&
    !isVideo(context)
  ) /* Safari has a known issue with service workers and videos: https://adactio.com/journal/14452 */
}

registerRoute(matchRuntimePath, async context => {
  try {
    const { url, event } = context

    if (isAmp(url)) {
      prefetch({ path: url.pathname + url.search }, true)
    }

    const headers = event.request.headers
    const apiVersion = headers.get('x-rsf-api-version')
    const cacheName = getAPICacheName(apiVersion)
    const cacheOptions = { ...runtimeCacheOptions, cacheName }

    if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
      return
    }

    if (!apiVersion) {
      return new NetworkOnly().handle(context)
    }
    // Check the cache for all routes. If the result is not found, get it from the network.
    return new CacheOnly(cacheOptions)
      .handle(context)
      .catch(() =>
        new NetworkOnly().handle(context).then(apiRes => {
          // 1. withReactStorefront should create a api_version value, which can just be the timestamp of the build
          // 2. it provide that to client and server build as a webpack define
          // 3. we should monkey-patch xhr to send x-rsf-api-version as a request header on all requests

          if (apiRes.headers.get('x-sw-cache-control')) {
            const path = url.pathname

            caches.open(cacheName).then(cache => {
              cache.put(path, apiRes)
              console.log('[react-storefront service worker]', `caching ${path}`)
            })
          }

          return apiRes.clone()
        }),
      )
      .catch(() => offlineResponse(apiVersion, context))
  } catch (e) {
    // if anything goes wrong, fallback to network
    // this is critical - if there is a bug in the service worker code, the whole site can stop working
    console.warn('[react-storefront service worker]', 'caught error in service worker', e)
    return new NetworkOnly().handle(context)
  }
})

skipWaiting()
clientsClaim()
precacheAndRoute(self.__WB_MANIFEST || [])

registerRoute(
  /^https?.*/,
  new NetworkFirst({
    cacheName: 'offlineCache',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 200,
        purgeOnQuotaError: true,
      }),
    ],
  }),
  'GET',
)
