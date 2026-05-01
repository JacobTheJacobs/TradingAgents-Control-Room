/**
 * Newsstand texture (TILE_TYPE 5)
 */
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createNewsstandTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { wood, props } = palette
  createTex(scene, 'news', 32, 32, (ctx) => {
    // Drop shadow
    ctx.fillStyle = props.shadow
    ctx.fillRect(6, 22, 24, 12)
    // Main body
    ctx.fillStyle = wood.dark
    ctx.fillRect(4, 18, 24, 14)
    ctx.fillStyle = props.paper
    ctx.fillRect(6, 4, 20, 14)
    ctx.fillStyle = props.neutralDark
    ctx.fillRect(8, 7, 16, 2)
    ctx.fillRect(8, 10, 12, 1)
    ctx.fillRect(8, 12, 14, 1)
  })
}
