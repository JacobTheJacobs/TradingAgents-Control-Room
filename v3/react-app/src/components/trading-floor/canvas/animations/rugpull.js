export function createRugpullAnim(scene, key) {
  scene.anims.create({ key: `${key}_rugpull`, frames: scene.anims.generateFrameNumbers(key, { start: 108, end: 111 }), frameRate: 8, repeat: -1 })
}
