export function createLamboAnim(scene, key) {
  scene.anims.create({ key: `${key}_lambo`, frames: scene.anims.generateFrameNumbers(key, { start: 112, end: 115 }), frameRate: 8, repeat: -1 })
}
