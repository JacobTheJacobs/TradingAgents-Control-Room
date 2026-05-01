/**
 * Asset index - exports all texture generators
 */
import { AGENTS } from '../../../../utils/constants'

// Tile type texture generators
import { createFloorTexture } from './floor'
import { createWallTextures } from './wall'
import { createDeskTexture } from './desk'
import { createTickerTexture } from './ticker'
import { createCoolerTexture } from './cooler'
import { createNewsstandTexture } from './newsstand'
import { createRugTexture } from './rug'
import { createCatTexture } from './cat'
import { createMoneyTexture } from './money'
import { createDoorTexture } from './door'
import { createCabinetTexture } from './cabinet'
import { createTVTexture } from './tv'
import { createWindowTexture } from './window'
import { createPlantTexture } from './plant'
import { createScannerTexture } from './scanner'
import { createTableTexture } from './table'

// Agent texture generators
import { createDetailedAgent, createBearAgent } from './agents'

// Glow effects
import { createGlowTextures } from './glows'

// Re-export helpers for use by other modules
export { roundRect, createTex, createSheet } from './helpers'

// Re-export individual texture creators for direct use
export {
  createFloorTexture,
  createWallTextures,
  createDeskTexture,
  createTickerTexture,
  createCoolerTexture,
  createNewsstandTexture,
  createRugTexture,
  createCatTexture,
  createMoneyTexture,
  createDoorTexture,
  createCabinetTexture,
  createTVTexture,
  createWindowTexture,
  createPlantTexture,
  createScannerTexture,
  createTableTexture,
  createDetailedAgent,
  createBearAgent,
  createGlowTextures
}

/**
 * Generate all game textures
 * @param {Phaser.Scene} scene - The Phaser scene to generate textures for
 */
export function generateTextures(scene, isEvening = false, options = {}) {
  const { skipAgents = false, skipCats = false } = options

  // Floor texture
  createFloorTexture(scene, isEvening)

  // Wall textures
  createWallTextures(scene, isEvening)

  // Window texture
  createWindowTexture(scene, isEvening)

  // Door texture
  createDoorTexture(scene, isEvening)

  // Rug texture
  createRugTexture(scene, isEvening)

  // Plant texture
  createPlantTexture(scene, isEvening)

  // Money texture
  createMoneyTexture(scene, isEvening)

  // Enhanced Desk with dual monitors and chair
  createDeskTexture(scene, isEvening)

  // Animated Ticker Board
  createTickerTexture(scene, isEvening)

  // Animated TV
  createTVTexture(scene, isEvening)

  // Water Cooler with drop shadow
  createCoolerTexture(scene, isEvening)

  // Newsstand with drop shadow
  createNewsstandTexture(scene, isEvening)

  // Cabinet with drop shadow
  createCabinetTexture(scene, isEvening)

  // Scanner (reuses desk texture)
  createScannerTexture(scene, isEvening)

  // Table
  createTableTexture(scene, isEvening)

  // Screen glow textures for monitors and TVs
  createGlowTextures(scene, isEvening)

  // Generate all agent sprites
  if (!skipAgents) {
    Object.entries(AGENTS).forEach(([name, config]) => {
      const key = `agent_${name.toLowerCase()}`
      if (name === 'Bear') {
        createBearAgent(scene, key, config.color, isEvening)
      } else {
        createDetailedAgent(scene, key, config.color, isEvening)
      }
    })
  }

  // Cat sprite
  if (!skipCats) {
    createCatTexture(scene, isEvening)
  }
}
