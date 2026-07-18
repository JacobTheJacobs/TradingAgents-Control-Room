export function createCopiumAnim(scene, key) {
  scene.anims.create({ key: `${key}_copium`, frames: scene.anims.generateFrameNumbers(key, { start: 104, end: 107 }), frameRate: 4, repeat: -1 })
}
