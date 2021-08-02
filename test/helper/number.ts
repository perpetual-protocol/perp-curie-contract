import bn from "bignumber.js"
import { BigNumberish } from "ethers"
import { formatEther } from "ethers/lib/utils"

export function fromWei(val: BigNumberish, decimals = 18): bn {
    return new bn(formatEther(val))
}

export const getMinTick = (tickSpacing: number) => Math.ceil(-887272 / tickSpacing) * tickSpacing
export const getMaxTick = (tickSpacing: number) => Math.floor(887272 / tickSpacing) * tickSpacing
