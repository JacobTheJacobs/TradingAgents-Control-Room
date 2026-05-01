export function createMoonAnim(scene, key) {
  scene.anims.create({ key: `${key}_moon`, frames: scene.anims.generateFrameNumbers(key, { start: 96, end: 99 }), frameRate: 8, repeat: -1 })
}
