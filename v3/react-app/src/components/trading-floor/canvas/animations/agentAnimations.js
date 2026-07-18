/**
 * Agent animation creators
 * Creates Phaser animations for agents and other sprites
 */
import { AGENTS } from '../../../../utils/constants'

import { createWalkDownAnim } from './walkDown'
import { createWalkSideAnim } from './walkSide'
import { createWalkUpAnim } from './walkUp'
import { createIdleAnim } from './idle'
import { createSitTypeAnim } from './sitType'
import { createSitBackAnim } from './sitBack'
import { createDrinkAnim } from './drink'
import { createTalkAnim } from './talk'
import { createPointAnim } from './point'
import { createCheerAnim } from './cheer'
import { createFacepalmAnim } from './facepalm'
import { createWhineAnim } from './whine'

import { createBuyAnim } from './buy'
import { createSellAnim } from './sell'
import { createHodlAnim } from './hodl'
import { createMoonAnim } from './moon'
import { createRektAnim } from './rekt'

import { createBagholderAnim } from './bagholder'
import { createCopiumAnim } from './copium'
import { createRugpullAnim } from './rugpull'
import { createLamboAnim } from './lambo'
import { createBrrrAnim } from './brrr'
import { createBulltrapAnim } from './bulltrap'
import { createDeadcatAnim } from './deadcat'
import { createMeltAnim } from './melt'
import { createBuydipAnim } from './buydip'
import { createRocketAnim } from './rocket'
import { createFatfingerAnim } from './fatfinger'
import { createLeverageAnim } from './leverage'
import { createTendiesAnim } from './tendies'
import { createWhaleAnim } from './whale'
import { createFedAnim } from './fed'

/**
 * Create animations for a specific agent
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {string} agentName - Name of the agent
 */
export function createAgentAnimations(scene, agentName) {
  const key = `agent_${agentName.toLowerCase()}`

  createWalkDownAnim(scene, key)
  createWalkSideAnim(scene, key)
  createWalkUpAnim(scene, key)
  createIdleAnim(scene, key)
  createSitTypeAnim(scene, key)
  createSitBackAnim(scene, key)
  createDrinkAnim(scene, key)
  createTalkAnim(scene, key)
  createPointAnim(scene, key)
  createCheerAnim(scene, key)
  createFacepalmAnim(scene, key)
  createWhineAnim(scene, key)
  
  createBuyAnim(scene, key)
  createSellAnim(scene, key)
  createHodlAnim(scene, key)
  createMoonAnim(scene, key)
  createRektAnim(scene, key)
  
  createBagholderAnim(scene, key)
  createCopiumAnim(scene, key)
  createRugpullAnim(scene, key)
  createLamboAnim(scene, key)
  createBrrrAnim(scene, key)
  
  createBulltrapAnim(scene, key)
  createDeadcatAnim(scene, key)
  createMeltAnim(scene, key)
  createBuydipAnim(scene, key)
  createRocketAnim(scene, key)
  createFatfingerAnim(scene, key)
  createLeverageAnim(scene, key)
  createTendiesAnim(scene, key)
  createWhaleAnim(scene, key)
  createFedAnim(scene, key)
}

/**
 * Create all animations for the scene
 * @param {Phaser.Scene} scene - The Phaser scene
 */
export function createAllAnimations(scene) {
  // Agent animations
  Object.keys(AGENTS).forEach(agentName => {
    createAgentAnimations(scene, agentName)
  })

  // Ticker animation
  scene.anims.create({ key: 'ticker_anim', frames: scene.anims.generateFrameNumbers('ticker', { start: 0, end: 3 }), frameRate: 4, repeat: -1 })

  // TV animation
  scene.anims.create({ key: 'tv_channel', frames: scene.anims.generateFrameNumbers('tv', { start: 0, end: 7 }), frameRate: 0.5, repeat: -1 })

  // Cat animations
  scene.anims.create({ key: 'cat_walk_down', frames: scene.anims.generateFrameNumbers('cat', { start: 0, end: 3 }), frameRate: 8, repeat: -1 })
  scene.anims.create({ key: 'cat_walk_side', frames: scene.anims.generateFrameNumbers('cat', { start: 4, end: 7 }), frameRate: 8, repeat: -1 })
  scene.anims.create({ key: 'cat_walk_up', frames: scene.anims.generateFrameNumbers('cat', { start: 8, end: 11 }), frameRate: 8, repeat: -1 })
  scene.anims.create({ key: 'cat_idle', frames: [{ key: 'cat', frame: 0 }, { key: 'cat', frame: 1 }], frameRate: 1, repeat: -1 })
}
