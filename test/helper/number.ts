import { parseUnits } from "@ethersproject/units"
import bn from "bignumber.js"
import { BigNumber, BigNumberish } from "ethers"

export function toWei(val: BigNumberish, decimals = 18): BigNumber {
    return parseUnits(new bn(val.toString()).toFixed(decimals), decimals)
}
