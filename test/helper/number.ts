import { BigNumber } from "@ethersproject/bignumber"
import { formatUnits, parseUnits } from "@ethersproject/units"
import Big from "big.js"

export function fromWei(wei: BigNumber, decimals = 18): Big {
    return Big(formatUnits(wei, decimals))
}

export function toWei(val: Big, decimals = 18): BigNumber {
    return parseUnits(val.toFixed(decimals), decimals)
}
