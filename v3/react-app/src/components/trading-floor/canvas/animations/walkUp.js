export function createWalkUpAnim(scene, key) {
  scene.anims.create({ key: `${key}_walk_up`, frames: scene.anims.generateFrameNumbers(key, { start: 8, end: 11 }), frameRate: 8, repeat: -1 })
}
