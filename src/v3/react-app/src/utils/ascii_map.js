import { TILE_TYPES } from './constants'

// Bidirectional mapping between TILE_TYPES and ASCII characters
export const ASCII_CHAR_MAP = {
    [TILE_TYPES.FLOOR]: '.',
    [TILE_TYPES.WALL]: '#',
    [TILE_TYPES.DESK]: 'D',
    [TILE_TYPES.TICKER]: '^',
    [TILE_TYPES.COOLER]: 'C',
    [TILE_TYPES.NEWSSTAND]: 'N',
    [TILE_TYPES.RUG]: 'R',
    [TILE_TYPES.CAT]: '@',
    [TILE_TYPES.MONEY]: '$',
    [TILE_TYPES.DOOR]: 'E', // 'E' for Entrance/Exit
    [TILE_TYPES.CABINET]: 'B', // 'B' for Box/Cabinet
    [TILE_TYPES.TV]: 'T',
    [TILE_TYPES.WINDOW]: 'W',
    [TILE_TYPES.PLANT]: 'P',
    [TILE_TYPES.SCANNER]: 'S',
    [TILE_TYPES.TABLE]: 'L' // 'L' for Table
}

// Map characters back to IDs for fast parsing
export const CHAR_TO_TILE_MAP = Object.entries(ASCII_CHAR_MAP).reduce((acc, [id, char]) => {
    acc[char] = parseInt(id, 10)
    return acc
}, {})

/**
 * Converts a 2D integer array (ROOM_MAP) into a multi-line ASCII string.
 */
export function serializeMapToAscii(roomMap) {
    if (!roomMap || !roomMap.length) return ''

    const lines = roomMap.map(row => {
        return row.map(tileId => ASCII_CHAR_MAP[tileId] || '?').join('')
    })

    return lines.join('\n')
}

/**
 * Parses a multi-line ASCII string back into a 2D integer array.
 * Ensures rows are padded or truncated to match the expected width.
 */
export function parseAsciiToMap(asciiString, expectedWidth = 20, expectedHeight = 14) {
    if (!asciiString) return null

    const lines = asciiString.split('\n')
        .map(line => line.trim())

    const newMap = []

    for (let r = 0; r < expectedHeight; r++) {
        const row = []
        const line = lines[r] || '' // Fallback to empty string if not enough lines

        for (let c = 0; c < expectedWidth; c++) {
            const char = line[c]
            const tileId = CHAR_TO_TILE_MAP[char]
            // Fallback to FLOOR if character is invalid or missing
            row.push(tileId !== undefined ? tileId : TILE_TYPES.FLOOR)
        }
        newMap.push(row)
    }

    return newMap
}
