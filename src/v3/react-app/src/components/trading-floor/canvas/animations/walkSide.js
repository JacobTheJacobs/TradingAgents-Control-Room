export function createWalkSideAnim(scene, key) {
  scene.anims.create({ key: `${key}_walk_side`, frames: scene.anims.generateFrameNumbers(key, { start: 4, end: 7 }), frameRate: 8, repeat: -1 })
}
