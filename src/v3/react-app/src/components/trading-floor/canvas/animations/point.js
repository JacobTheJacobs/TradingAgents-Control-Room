export function createPointAnim(scene, key) {
  scene.anims.create({ key: `${key}_point`, frames: scene.anims.generateFrameNumbers(key, { start: 36, end: 39 }), frameRate: 4, repeat: -1 })
}
