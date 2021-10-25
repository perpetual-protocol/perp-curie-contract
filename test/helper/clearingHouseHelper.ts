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
    const posSize = await fixture.accountBalance.getPositionSize(wallet.address, baseToken)
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

export async function removeAllOrders(
    fixture: ClearingHouseFixture,
    wallet: Wallet,
    baseToken: string = fixture.baseToken.address,
): Promise<void> {
    const orderBook: OrderBook = fixture.orderBook
    const clearingHouse: ClearingHouse = fixture.clearingHouse
    const orderIds = await orderBook.getOpenOrderIds(wallet.address, baseToken)
    for (const orderId of orderIds) {
        const { lowerTick, upperTick, liquidity } = await orderBook.getOpenOrderById(orderId)
        await clearingHouse.connect(wallet).removeLiquidity({
            baseToken: baseToken,
            lowerTick,
            upperTick,
            liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })
    }
}
