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
    baseAmount: BigNumberish
    quoteAmount: BigNumberish
}
export interface Token01AmountPair {
    token0Amount: BigNumberish
    token1Amount: BigNumberish
}

export function token01toBaseQuote(
    baseAddress: string,
    quoteAddress: string,
    pair: Token01AmountPair,
): BaseQuoteAmountPair {
    const { token0Amount, token1Amount } = pair
    const isBase0Quote1 = baseAddress.toLowerCase() < quoteAddress.toLowerCase()
    if (isBase0Quote1) {
        return { baseAmount: token0Amount, quoteAmount: token1Amount }
    }
    return { baseAmount: token1Amount, quoteAmount: token0Amount }
}
