import bn from "bignumber.js"
import { BigNumber, BigNumberish } from "ethers"
import { TestERC20 } from "../../typechain"

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

export function sortedTokens(tokenA: TestERC20, tokenB: TestERC20): { token0: TestERC20; token1: TestERC20 } {
    const [token0, token1] = [tokenA, tokenB].sort((tokenA, tokenB) =>
        tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? -1 : 1,
    )
    return { token0, token1 }
}

export interface BaseQuoteAmountPair {
    base: BigNumberish
    quote: BigNumberish
}

export function token01toBaseQuote(
    baseAddr: string,
    quoteAddr: string,
    token0: BigNumberish,
    token1: BigNumberish,
): BaseQuoteAmountPair {
    if (isAscendingTokenOrder(baseAddr, quoteAddr)) {
        return { base: token0, quote: token1 }
    }
    return { base: token1, quote: token0 }
}

export function isAscendingTokenOrder(addr0: string, addr1: string): boolean {
    return addr0.toLowerCase() < addr1.toLowerCase()
}
