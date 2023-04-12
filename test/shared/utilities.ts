import { BaseContract, BigNumber, BigNumberish } from "ethers"
import { BaseToken, Exchange, TestAccountBalance, UniswapV3Pool, VirtualToken } from "../../typechain"

import { MockContract } from "@eth-optimism/smock"
import { LogDescription } from "@ethersproject/abi"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
import bn from "bignumber.js"
import { parseEther } from "ethers/lib/utils"

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

function bigNumberToBig(val: BigNumber, decimals: number = 18): bn {
    return new bn(val.toString()).div(new bn(10).pow(decimals))
}

export function formatSqrtPriceX96ToPrice(value: BigNumber, decimals: number = 18): string {
    return bigNumberToBig(value, 0).div(new bn(2).pow(96)).pow(2).dp(decimals).toString()
}

export function getMarginRatio(accountValue: BigNumber, totalAbsPositionValue: BigNumber): bn {
    return new bn(accountValue.toString()).div(totalAbsPositionValue.toString())
}

export function calculateLiquidatePositionSize(
    positionSize: BigNumber,
    totalAbsPositionValue: BigNumber,
    absPositionValue: BigNumber,
): BigNumber {
    // max liquidate ratio = MIN(1, 0.5 * totalAbsPositionValue / liquidatePositionValue)
    let liquidateRatio = new bn(totalAbsPositionValue.toString())
        .div(2)
        .div(new bn(absPositionValue.toString()))
        .decimalPlaces(6, 1)
    liquidateRatio = bn.min(new bn(1), liquidateRatio)
    return BigNumber.from(new bn(positionSize.toString()).multipliedBy(liquidateRatio).integerValue(1).toString())
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

export function isAscendingTokenOrder(addr0: string, addr1: string): boolean {
    return addr0.toLowerCase() < addr1.toLowerCase()
}

export function filterLogs(receipt: TransactionReceipt, topic: string, baseContract: BaseContract): LogDescription[] {
    return receipt.logs.filter(log => log.topics[0] === topic).map(log => baseContract.interface.parseLog(log))
}

export async function mockIndexPrice(mockedPriceFeedDispatcher: MockContract, price: string) {
    // decimals of PriceFeedDispatcher is 18, thus parseEther()
    mockedPriceFeedDispatcher.smocked.getDispatchedPrice.will.return.with(parseEther(price))
}

export async function mockMarkPrice(accountBalance: TestAccountBalance, baseToken: string, price: string) {
    await accountBalance.mockMarkPrice(baseToken, parseEther(price))
}

export async function syncIndexToMarketPrice(mockedPriceFeedDispatcher: MockContract, pool: UniswapV3Pool) {
    const slot0 = await pool.slot0()
    const sqrtPrice = slot0.sqrtPriceX96
    const price = formatSqrtPriceX96ToPrice(sqrtPrice)
    mockIndexPrice(mockedPriceFeedDispatcher, price)
}

export async function syncMarkPriceToMarketPrice(
    accountBalance: TestAccountBalance,
    baseToken: string,
    pool: UniswapV3Pool,
) {
    const slot0 = await pool.slot0()
    const sqrtPrice = slot0.sqrtPriceX96
    const price = formatSqrtPriceX96ToPrice(sqrtPrice)
    await accountBalance.mockMarkPrice(baseToken, parseEther(price))
}

export async function getMarketTwap(exchange: Exchange, baseToken: BaseToken, interval: number) {
    const sqrtPrice = await exchange.getSqrtMarketTwapX96(baseToken.address, interval)
    return formatSqrtPriceX96ToPrice(sqrtPrice)
}
