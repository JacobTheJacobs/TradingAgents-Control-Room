// useWebSocket Hook
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'

/**
 * Custom hook for WebSocket connection
 * @param {string} url - WebSocket URL
 * @param {Function} onMessage - Callback for incoming messages
 * @returns {{ connected: boolean, send: Function, ws: WebSocket|null }}
 */
export function useWebSocket(url, onMessage) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef(null)
  const onMessageRef = useRef(onMessage)
  const reconnectRef = useRef(null)
  const urlIndexRef = useRef(0)
  const urlsRef = useRef([])
  const activeRef = useRef(true)
  const lastGoodIndexRef = useRef(null)
  const heartbeatRef = useRef(null)
  
  // Keep the callback ref updated
  useEffect(() => {
    onMessageRef.current = onMessage
  }, [onMessage])
  
  const urlKey = useMemo(() => {
    if (!url) return ''
    return Array.isArray(url) ? url.join('|') : String(url)
  }, [url])

  const connect = useCallback(() => {
    if (!urlsRef.current.length) return
    const nextUrl = urlsRef.current[urlIndexRef.current]
    if (!nextUrl) return

    const ws = new WebSocket(nextUrl)
    
    ws.onopen = () => {
      setConnected(true)
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current)
        reconnectRef.current = null
      }
      lastGoodIndexRef.current = urlIndexRef.current
      console.log('[WebSocket] Connected to', nextUrl)
      
      // Start heartbeat to prevent server 60s timeout
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
      heartbeatRef.current = setInterval(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }))
        }
      }, 30000) // 30 seconds
    }
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        console.log('[WebSocket] Received message type:', data.type, data)
        onMessageRef.current?.(data)
      } catch (e) {
        console.warn('[WebSocket] Parse error:', e)
      }
    }
    
    ws.onclose = (event) => {
      setConnected(false)
      console.log('[WebSocket] Disconnected', { code: event?.code, reason: event?.reason, wasClean: event?.wasClean })
      wsRef.current = null
      
      // Clear heartbeat on disconnect
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current)
        heartbeatRef.current = null
      }
      
      if (!activeRef.current) return

      // Prefer last known-good URL
      if (lastGoodIndexRef.current !== null) {
        urlIndexRef.current = lastGoodIndexRef.current
        reconnectRef.current = setTimeout(connect, 1500)
        return
      }

      // No successful connection yet: try next URL
      if (urlIndexRef.current < urlsRef.current.length - 1) {
        urlIndexRef.current += 1
        reconnectRef.current = setTimeout(connect, 800)
        return
      }

      urlIndexRef.current = 0
      reconnectRef.current = setTimeout(connect, 3000)
    }
    
    ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error)
      try {
        ws.close()
      } catch { }
    }
    
    wsRef.current = ws
  }, [])

  useEffect(() => {
    if (!urlKey) return
    urlsRef.current = Array.isArray(url) ? url.filter(Boolean) : [url]
    urlIndexRef.current = 0
    lastGoodIndexRef.current = null
    activeRef.current = true
    connect()

    return () => {
      activeRef.current = false
      if (wsRef.current) wsRef.current.close()
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      if (heartbeatRef.current) clearInterval(heartbeatRef.current)
    }
  }, [urlKey, connect])
  
  const send = useCallback((data) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])
  
  return { 
    connected, 
    send, 
    ws: wsRef.current 
  }
}
