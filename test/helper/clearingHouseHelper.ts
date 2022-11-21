import { LogDescription } from "@ethersproject/abi"
import { TransactionReceipt } from "@ethersproject/abstract-provider"
import { BigNumberish, ContractTransaction, ethers, Wallet } from "ethers"
import { parseEther } from "ethers/lib/utils"
import { ClearingHouse, OrderBook } from "../../typechain"
import { ClearingHouseFixture } from "../clearingHouse/fixtures"

export function q2bExactInput(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    amount: BigNumberish,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction> {
    return fixture.clearingHouse.connect(wallet).openPosition({
        baseToken,
        isBaseToQuote: false,
        isExactInput: true,
        oppositeAmountBound: 0,
        amount: parseEther(amount.toString()),
        sqrtPriceLimitX96: 0,
        deadline: ethers.constants.MaxUint256,
        referralCode: ethers.constants.HashZero,
    })
}

export function b2qExactInput(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    amount: BigNumberish,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction> {
    return fixture.clearingHouse.connect(wallet).openPosition({
        baseToken,
        isBaseToQuote: true,
        isExactInput: true,
        oppositeAmountBound: 0,
        amount: parseEther(amount.toString()),
        sqrtPriceLimitX96: 0,
        deadline: ethers.constants.MaxUint256,
        referralCode: ethers.constants.HashZero,
    })
}

export function q2bExactOutput(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    amount: BigNumberish,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction> {
    return fixture.clearingHouse.connect(wallet).openPosition({
        baseToken,
        isBaseToQuote: false,
        isExactInput: false,
        oppositeAmountBound: 0,
        amount: parseEther(amount.toString()),
        sqrtPriceLimitX96: 0,
        deadline: ethers.constants.MaxUint256,
        referralCode: ethers.constants.HashZero,
    })
}

export function b2qExactOutput(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    amount: BigNumberish,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction> {
    return fixture.clearingHouse.connect(wallet).openPosition({
        baseToken,
        isBaseToQuote: true,
        isExactInput: false,
        oppositeAmountBound: 0,
        amount: parseEther(amount.toString()),
        sqrtPriceLimitX96: 0,
        deadline: ethers.constants.MaxUint256,
        referralCode: ethers.constants.HashZero,
    })
}

export async function closePosition(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    ignorableDustPosSize: number = 0,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction | undefined> {
    const posSize = await fixture.accountBalance.getTotalPositionSize(wallet.address, baseToken)
    if (posSize.abs().lt(ignorableDustPosSize)) {
        // skip, may fail if the pos size is too small
        return
    }

    return fixture.clearingHouse.connect(wallet).closePosition({
        baseToken,
        sqrtPriceLimitX96: 0,
        oppositeAmountBound: 0,
        deadline: ethers.constants.MaxUint256,
        referralCode: ethers.constants.HashZero,
    })
}

export function addOrder(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    base: BigNumberish,
    quote: BigNumberish,
    lowerTick: BigNumberish,
    upperTick: BigNumberish,
    useTakerBalance: boolean = false,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction> {
    return fixture.clearingHouse.connect(wallet).addLiquidity({
        baseToken,
        base: parseEther(base.toString()),
        quote: parseEther(quote.toString()),
        lowerTick,
        upperTick,
        minBase: 0,
        minQuote: 0,
        useTakerBalance,
        deadline: ethers.constants.MaxUint256,
    })
}

export async function removeOrder(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    liquidity: BigNumberish,
    lowerTick: BigNumberish,
    upperTick: BigNumberish,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction | undefined> {
    const order = await fixture.orderBook.getOpenOrder(wallet.address, baseToken, lowerTick, upperTick)
    if (order.liquidity.isZero()) {
        return
    }
    return fixture.clearingHouse.connect(wallet).removeLiquidity({
        baseToken,
        liquidity,
        lowerTick,
        upperTick,
        minBase: 0,
        minQuote: 0,
        deadline: ethers.constants.MaxUint256,
    })
}

export async function getOrderIds(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    baseToken: string = fixture.baseToken.address,
): Promise<string[]> {
    const orderBook: OrderBook = fixture.orderBook
    return await orderBook.getOpenOrderIds(wallet.address, baseToken)
}

export async function removeAllOrders(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    baseToken: string = fixture.baseToken.address,
): Promise<ContractTransaction[]> {
    const orderIds = await getOrderIds(fixture, wallet, baseToken)
    const clearingHouse: ClearingHouse = fixture.clearingHouse
    const orderBook: OrderBook = fixture.orderBook
    const txs = []
    for (const orderId of orderIds) {
        const { lowerTick, upperTick, liquidity } = await orderBook.getOpenOrderById(orderId)
        txs.push(
            await clearingHouse.connect(wallet).removeLiquidity({
                baseToken: baseToken,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }),
        )
    }
    return txs
}

export function findPnlRealizedEvents(fixture: ClearingHouseFixture, receipt: TransactionReceipt): LogDescription[] {
    const pnlRealizedTopic = fixture.accountBalance.interface.getEventTopic("PnlRealized")
    return receipt.logs
        .filter(log => log.topics[0] === pnlRealizedTopic)
        .map(log => fixture.accountBalance.interface.parseLog(log))
}

export function findLiquidityChangedEvents(
    fixture: ClearingHouseFixture,
    receipt: TransactionReceipt,
): LogDescription[] {
    const topic = fixture.clearingHouse.interface.getEventTopic("LiquidityChanged")
    return receipt.logs.filter(log => log.topics[0] === topic).map(log => fixture.clearingHouse.interface.parseLog(log))
}
