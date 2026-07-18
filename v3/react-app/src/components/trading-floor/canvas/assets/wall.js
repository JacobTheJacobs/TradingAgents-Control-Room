/**
 * Wall textures (TILE_TYPE 1)
 * Includes: wall_face, wall_side, wall_corner
 */
import { TILE_SIZE } from '../../../../utils/constants'
import { createTex } from './helpers'
import { getPalette } from './palette'

export function createWallTextures(scene, isEvening = false) {
  const palette = getPalette(isEvening)
  const { wall } = palette

  // Wall face texture
  createTex(scene, 'wall_face', TILE_SIZE, TILE_SIZE, (ctx) => {
    // Drop shadow (bottom-right offset)
    ctx.fillStyle = wall.shadow
    ctx.fillRect(3, 3, TILE_SIZE, TILE_SIZE)
    // Main wall
    ctx.fillStyle = wall.face
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
    
    // Paneling details
    ctx.fillStyle = wall.panel
    ctx.fillRect(TILE_SIZE * 0.3, 2, 1, TILE_SIZE - 4)
    ctx.fillRect(TILE_SIZE * 0.6, 2, 1, TILE_SIZE - 4)
    
    // Top highlight (Rim light)
    ctx.fillStyle = wall.highlight
    ctx.fillRect(0, 0, TILE_SIZE, 1)
    
    ctx.strokeStyle = wall.line
    ctx.lineWidth = 1
    ctx.strokeRect(0, 0, TILE_SIZE, TILE_SIZE)
  })

  // Wall side texture
  createTex(scene, 'wall_side', TILE_SIZE, TILE_SIZE, (ctx) => {
    // Drop shadow
    ctx.fillStyle = wall.shadow
    ctx.fillRect(3, 3, TILE_SIZE, TILE_SIZE)
    // Main wall
    ctx.fillStyle = wall.side
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
    
    // Side texture depth
    ctx.fillStyle = wall.line
    ctx.fillRect(2, 0, TILE_SIZE - 4, TILE_SIZE)
    
    // Top highlight
    ctx.fillStyle = wall.highlight
    ctx.fillRect(0, 0, TILE_SIZE, 1)
  })

  // Wall corner texture
  createTex(scene, 'wall_corner', TILE_SIZE, TILE_SIZE, (ctx) => {
    // Drop shadow
    ctx.fillStyle = wall.shadow
    ctx.fillRect(3, 3, TILE_SIZE, TILE_SIZE)
    // Main wall
    ctx.fillStyle = wall.corner
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE)
    ctx.fillStyle = wall.face
    ctx.fillRect(2, 2, TILE_SIZE - 4, TILE_SIZE - 4)
  })
}
