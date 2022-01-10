export const getMinTick = (tickSpacing: number) => Math.ceil(-887272 / tickSpacing) * tickSpacing
export const getMaxTick = (tickSpacing: number) => Math.floor(887272 / tickSpacing) * tickSpacing
export const getMaxTickRange = (tickSpacing: number) => getMaxTick(tickSpacing) - getMinTick(tickSpacing)
