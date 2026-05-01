export function createDrinkAnim(scene, key) {
  scene.anims.create({ key: `${key}_drink`, frames: scene.anims.generateFrameNumbers(key, { start: 28, end: 31 }), frameRate: 4, repeat: -1 })
}
