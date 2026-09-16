// Transport/serialization adapted from Tauri 2.11.5 ipc-protocol.js and
// process-ipc-message-fn.js; Copyright 2019-2024 Tauri Programme within The
// Commons Conservancy. SPDX-License-Identifier: Apache-2.0 OR MIT
// https://github.com/tauri-apps/tauri/tree/tauri-v2.11.5/crates/tauri/scripts
// LocalView addition: never provision the invoke key to preview/subframes or
// untrusted navigations. Keep this adapter aligned when upgrading Tauri.
;(function () {
  const bridge = window.__TAURI_INTERNALS__
  const url = new URL(window.location.href)
  const app = url.origin === 'http://tauri.localhost'
    && (url.pathname === '/' || url.pathname === '/index.html')
  const dev = __LOCALVIEW_DEV__
    && (url.origin === 'http://localhost:1420' || url.origin === 'http://127.0.0.1:1420')
  if (window.top !== window || (!app && !dev)) {
    Object.defineProperty(bridge, 'postMessage', {
      value: Object.freeze((message) => {
        bridge.runCallback(message.error, 'Command not allowed from document preview')
      })
    })
    return
  }

  // This placeholder is supplied by Builder::invoke_system. A closure variable
  // prevents the invoke key from leaking through postMessage.toString().
  const invokeKey = __INVOKE_KEY__
  let protocolFailed = false
  function processMessage(message) {
    if (message instanceof ArrayBuffer || ArrayBuffer.isView(message) || Array.isArray(message)) {
      return { contentType: 'application/octet-stream', data: message }
    }
    return {
      contentType: 'application/json',
      data: JSON.stringify(message, (_key, value) => {
        if (value instanceof Map) return Object.fromEntries(value.entries())
        if (value instanceof Uint8Array) return Array.from(value)
        if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value))
        if (typeof value === 'object' && value !== null && '__TAURI_TO_IPC_KEY__' in value) {
          return value.__TAURI_TO_IPC_KEY__()
        }
        return value
      })
    }
  }
  function send(message) {
    const { cmd, callback, error, payload, options } = message
    if (!protocolFailed || cmd === 'plugin:__TAURI_CHANNEL__|fetch') {
      const { contentType, data } = processMessage(payload)
      const headers = new Headers((options && options.headers) || {})
      headers.set('Content-Type', contentType)
      headers.set('Tauri-Callback', callback)
      headers.set('Tauri-Error', error)
      headers.set('Tauri-Invoke-Key', invokeKey)
      fetch(bridge.convertFileSrc(cmd, 'ipc'), { method: 'POST', body: data, headers })
        .then((response) => {
          const id = response.headers.get('Tauri-Response') === 'ok' ? callback : error
          switch ((response.headers.get('content-type') || '').split(',')[0]) {
            case 'application/json': return response.json().then(value => [id, value])
            case 'text/plain': return response.text().then(value => [id, value])
            default: return response.arrayBuffer().then(value => [id, value])
          }
        })
        .then(([id, value]) => bridge.runCallback(id, value), () => {
          protocolFailed = true
          send(message)
        })
    } else {
      const { data } = processMessage({
        cmd, callback, error,
        options: { ...options, customProtocolIpcBlocked: protocolFailed },
        payload, __TAURI_INVOKE_KEY__: invokeKey
      })
      window.ipc.postMessage(data)
    }
  }
  Object.defineProperty(bridge, 'postMessage', { value: send })
})()
