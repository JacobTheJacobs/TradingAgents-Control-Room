export function createTendiesAnim(scene, key) {
  scene.anims.create({ key: `${key}_tendies`, frames: scene.anims.generateFrameNumbers(key, { start: 148, end: 151 }), frameRate: 8, repeat: -1 })
}
