import bn from "bignumber.js"
import { BigNumber, BigNumberish } from "ethers"
import { VirtualToken } from "../../typechain"

bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 })

export function encodePriceSqrt(reserve1: BigNumberish, reserve0: BigNumberish): BigNumber {
    return BigNumber.from(
        new bn(reserve1.toString())
            .div(reserve0.toString())
            .sqrt()
            .multipliedBy(new bn(2).pow(96))
            .integerValue(3)
            .toString(),
    )
}

function bigNumber2Big(val: BigNumber, decimals: number = 18) {
    return new bn(val.toString()).div(new bn(10).pow(decimals))
}

export function formatSqrtX96(value: BigNumber, decimals: number = 18): string {
    return bigNumber2Big(value, 0).div(new bn(2).pow(96)).pow(2).dp(decimals).toString()
}

export function sortedTokens(
    tokenA: VirtualToken,
    tokenB: VirtualToken,
): { token0: VirtualToken; token1: VirtualToken } {
    const [token0, token1] = [tokenA, tokenB].sort((tokenA, tokenB) =>
        tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1,
    )
    return { token0, token1 }
}

export interface BaseQuoteAmountPair {
    base: BigNumberish
    quote: BigNumberish
}

export function isAscendingTokenOrder(addr0: string, addr1: string): boolean {
    return addr0.toLowerCase() < addr1.toLowerCase()
}
