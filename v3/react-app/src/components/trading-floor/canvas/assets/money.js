/**
 * Money texture (TILE_TYPE 8)
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createMoneyTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { props } = palette
  createTex(scene, 'money', TILE_SIZE, TILE_SIZE, (ctx) => {
    ctx.fillStyle = props.warning
    ctx.beginPath()
    ctx.arc(16, 16, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = props.accent
    ctx.font = 'bold 14px "Press Start 2P"'
    ctx.textAlign = 'center'
    ctx.fillText('$', 16, 20)
  })
}
