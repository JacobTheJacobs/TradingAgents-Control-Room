export function createWalkDownAnim(scene, key) {
  scene.anims.create({ key: `${key}_walk_down`, frames: scene.anims.generateFrameNumbers(key, { start: 0, end: 3 }), frameRate: 8, repeat: -1 })
}
