/**
 * Ticker board texture (TILE_TYPE 3)
 * Animated ticker board with stock display
 */
import { createSheet, roundRect } from './helpers'
import { getPalette } from './palette'

export function createTickerTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { ticker } = palette
  const tCanvas = document.createElement('canvas')
  tCanvas.width = 384
  tCanvas.height = 48
  const tCtx = tCanvas.getContext('2d')
  if (tCtx) {
    tCtx.imageSmoothingEnabled = false
    tCtx.webkitImageSmoothingEnabled = false
    tCtx.mozImageSmoothingEnabled = false
  }

  for (let f = 0; f < 4; f++) {
    const x = f * 96

    // Frame
    tCtx.fillStyle = ticker.frame
    roundRect(tCtx, x + 1, 1, 94, 46, 5)
    tCtx.fillStyle = ticker.frameInner
    roundRect(tCtx, x + 3, 3, 90, 42, 4)
    tCtx.fillStyle = ticker.screenTop
    roundRect(tCtx, x + 5, 5, 86, 38, 3)

    // Screen gradient
    const gradient = tCtx.createLinearGradient(x + 6, 6, x + 6, 42)
    gradient.addColorStop(0, ticker.screenTop)
    gradient.addColorStop(1, ticker.screenBottom)
    tCtx.fillStyle = gradient
    tCtx.fillRect(x + 6, 6, 84, 36)

    // Scanlines
    tCtx.fillStyle = ticker.scan
    for (let i = 0; i < 36; i += 2) {
      tCtx.fillRect(x + 6, 6 + i, 84, 1)
    }

    // Labels
    tCtx.fillStyle = ticker.label
    tCtx.font = 'bold 8px monospace'
    tCtx.fillText('S&P 500', x + 8, 14)
    tCtx.font = 'bold 9px monospace'
    tCtx.fillText('↑ 5,847', x + 8, 24)

    // Chart
    tCtx.strokeStyle = ticker.chart
    tCtx.lineWidth = 2
    tCtx.shadowColor = ticker.chartDim
    tCtx.shadowBlur = 2
    tCtx.beginPath()
    tCtx.moveTo(x + 6, 35)
    for (let i = 0; i < 84; i += 3) {
      const wave = Math.sin(i * 0.15 + f * 0.8) * 4
      tCtx.lineTo(x + 6 + i, 35 + wave - i * 0.05)
    }
    tCtx.stroke()
    tCtx.shadowBlur = 0
  }
  createSheet(scene, 'ticker', tCanvas, 96, 48)
}
