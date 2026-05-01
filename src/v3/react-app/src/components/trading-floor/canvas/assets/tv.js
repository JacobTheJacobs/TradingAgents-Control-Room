/**
 * TV texture (TILE_TYPE 11)
 * Animated TV with different channels
 */
import { createSheet, roundRect } from './helpers'
import { getPalette } from './palette'

export function createTVTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { tv, props } = palette
  const tvCanvas = document.createElement('canvas')
  tvCanvas.width = 640
  tvCanvas.height = 64
  const tvCtx = tvCanvas.getContext('2d')
  if (tvCtx) {
    tvCtx.imageSmoothingEnabled = false
    tvCtx.webkitImageSmoothingEnabled = false
    tvCtx.mozImageSmoothingEnabled = false
  }

  for (let f = 0; f < 8; f++) {
    const x = f * 80

    // TV frame
    tvCtx.fillStyle = tv.frame
    roundRect(tvCtx, x + 1, 1, 78, 52, 5)
    tvCtx.fillStyle = tv.frameInner
    roundRect(tvCtx, x + 3, 3, 74, 48, 4)

    // Screen
    const isRed = (f === 1 || f === 2)
    const isGreen = (f === 4 || f === 6)
    tvCtx.fillStyle = isRed ? tv.screenRed : (isGreen ? tv.screenGreen : tv.screenBlue)
    tvCtx.fillRect(x + 7, 7, 66, 40)

    // TV stand
    tvCtx.fillStyle = tv.frameInner
    tvCtx.fillRect(x + 30, 52, 20, 3)
    tvCtx.fillStyle = tv.frame
    tvCtx.fillRect(x + 25, 55, 30, 8)

    // Host figure
    const hostX = x + 40
    const hostY = (f === 7) ? 38 : 30
    tvCtx.fillStyle = tv.screenBlue
    tvCtx.fillRect(hostX - 10, hostY, 20, (f === 7) ? 8 : 14)

    // Face
    tvCtx.fillStyle = props.skin
    tvCtx.beginPath()
    tvCtx.arc(hostX, (f === 7) ? hostY - 4 : hostY - 6, (f === 7) ? 6 : 7, 0, Math.PI * 2)
    tvCtx.fill()

    // Banner
    tvCtx.fillStyle = tv.banner
    tvCtx.fillRect(x + 7, 38, 66, 8)

    const texts = ['MAD MONEY', 'SELL', 'BUZZER', 'TRASH', 'BUY', 'ALERT', 'BULL', 'CLOSED']
    tvCtx.fillStyle = tv.text
    tvCtx.font = 'bold 7px monospace'
    tvCtx.textAlign = 'center'
    tvCtx.fillText(texts[f], x + 40, 44)
  }
  createSheet(scene, 'tv', tvCanvas, 80, 64)
}
