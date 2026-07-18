/**
 * Plant texture (TILE_TYPE 13)
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createPlantTexture(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { props } = palette
  createTex(scene, 'plant', TILE_SIZE, TILE_SIZE, (ctx) => {
    ctx.fillStyle = props.pot
    ctx.fillRect(10, 20, 12, 12)
    ctx.fillStyle = props.leaf
    ctx.beginPath()
    ctx.arc(16, 12, 10, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = props.leafLight
    ctx.beginPath()
    ctx.arc(14, 10, 4, 0, Math.PI * 2)
    ctx.fill()
  })
}
