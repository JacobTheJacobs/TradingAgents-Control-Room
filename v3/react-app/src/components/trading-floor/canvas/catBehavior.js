// Cat Behavior - Cat wandering AI
import Phaser from 'phaser'
import { getGridPos, isWalkable, findPathToCoord, findRandomWalkable } from './pathfinding'
import { TILE_SIZE } from '../../../utils/constants'

/**
 * Start cat wandering behavior
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {Phaser.GameObjects.Sprite} cat - The cat sprite
 */
export function startCatBehavior(scene, cat) {
  const wander = () => {
    if (!cat.active) return

    const path = findPathToRandom(scene, cat)
    if (path) {
      startCatPathMovement(scene, cat, path, () => {
        scene.time.delayedCall(Phaser.Math.Between(3000, 8000), wander)
      })
    } else {
      scene.time.delayedCall(2000, wander)
    }
  }

  scene.time.delayedCall(Phaser.Math.Between(1000, 5000), wander)
}

/**
 * Find path to a random walkable tile for cat
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {Phaser.GameObjects.Sprite} cat - The cat sprite
 * @returns {Array|null} Path array or null
 */
export function findPathToRandom(scene, cat) {
  const start = getGridPos(cat.x, cat.y)
  const target = findRandomWalkable()

  if (!target) return null
  return findPathToCoord(null, start.c, start.r, target.c, target.r)
}

/**
 * Start cat path movement with animations
 * @param {Phaser.Scene} scene - The Phaser scene
 * @param {Phaser.GameObjects.Sprite} cat - The cat sprite
 * @param {Array} path - Path array
 * @param {Function} onComplete - Callback when movement completes
 */
export function startCatPathMovement(scene, cat, path, onComplete) {
  if (!path || path.length === 0) {
    if (onComplete) onComplete()
    return
  }

  let stepIdx = 0
  const moveNext = () => {
    if (!cat || !cat.active) return
    if (stepIdx >= path.length) {
      cat.play('cat_idle', true)
      if (onComplete) onComplete()
      return
    }

    const p = path[stepIdx]
    stepIdx++

    const dx = p.x - cat.x
    const dy = p.y - cat.y

    // Choose animation based on direction
    if (Math.abs(dy) > Math.abs(dx)) {
      cat.play(dy > 0 ? 'cat_walk_down' : 'cat_walk_up', true)
    } else {
      cat.play('cat_walk_side', true)
      cat.setFlipX(dx < 0)
    }

    scene.tweens.add({
      targets: cat,
      x: p.x,
      y: p.y,
      duration: 200,
      ease: 'Linear',
      onComplete: moveNext
    })
  }

  moveNext()
}
