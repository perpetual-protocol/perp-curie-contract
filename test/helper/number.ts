import { parseUnits } from "@ethersproject/units"
import bn from "bignumber.js"
import { BigNumber, BigNumberish } from "ethers"
import { formatEther } from "ethers/lib/utils"

export function toWei(val: BigNumberish, decimals = 18): BigNumber {
    return parseUnits(new bn(val.toString()).toFixed(decimals), decimals)
}

export function fromWei(val: BigNumberish, decimals = 18): bn {
    return new bn(formatEther(val))
}

export const getMinTick = (tickSpacing: number) => Math.ceil(-887272 / tickSpacing) * tickSpacing
export const getMaxTick = (tickSpacing: number) => Math.floor(887272 / tickSpacing) * tickSpacing
