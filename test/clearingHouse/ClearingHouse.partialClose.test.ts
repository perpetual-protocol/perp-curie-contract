import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forwardTimestamp } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse partial close in xyk pool", () => {
    const [admin, maker, alice, carol, liquidator] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    let lowerTick: number
    let upperTick: number

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        clearingHouseConfig = _clearingHouseFixture.clearingHouseConfig
        exchange = _clearingHouseFixture.exchange
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("10", 6), 0, 0, 0]
        })
        await pool.initialize(encodePriceSqrt("10", "1"))
        await marketRegistry.addPool(baseToken.address, "10000")

        const tickSpacing = await pool.tickSpacing()
        lowerTick = getMinTick(tickSpacing)
        upperTick = getMaxTick(tickSpacing)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("1000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // prepare collateral for alice
        const aliceCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(alice.address, aliceCollateral)
        await collateral.connect(alice).approve(clearingHouse.address, aliceCollateral)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for carol
        const carolCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(carol.address, carolCollateral)
        await collateral.connect(carol).approve(clearingHouse.address, carolCollateral)
        await deposit(carol, vault, 1000, collateral)

        // price delta for every tick is 0.01%
        // if we want to limit price impact to 1%, and 1% / 0.01% = 100
        // so limiting price impact to 1% means tick should not cross 100 ticks
        await exchange.connect(admin).setMaxTickCrossedWithinBlock(baseToken.address, 100)
        await clearingHouseConfig.connect(admin).setPartialCloseRatio(250000) // 25%
    })

    // https://docs.google.com/spreadsheets/d/1cVd-sM9HCeEczgmyGtdm1DH3vyoYEN7ArKfXx7DztEk/edit#gid=577678159
    describe("partial close", () => {
        beforeEach(async () => {
            // carol first shorts 25 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-25"))

            // move to next block to simplify test case
            // otherwise we need to bring another trader to move the price further away

            await forwardTimestamp(clearingHouse)
        })

        it("carol reduces position with openPosition and it's not over price limit", async () => {
            // carol longs 0.1 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: ethers.constants.MaxUint256,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-24.9"))
        })

        it("carol's position is partially closed with closePosition when it's over price limit", async () => {
            // remaining position size = -25 - (-25 * 1/4) = -18.75
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-18.75"))
        })

        // values are the same as the above one
        it("force error, partially closing position/isOverPriceLimit can happen once", async () => {
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await expect(
                clearingHouse.connect(carol).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_AOPLO")
        })

        it("force error, partial closing a position does not apply to opening a reverse position with openPosition", async () => {
            // carol longs 25 eth
            await expect(
                clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: ethers.constants.MaxUint256,
                    amount: parseEther("25"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.revertedWith("EX_OPLAS")
        })
    })

    describe("partial close with given oppositeAmountBound", () => {
        beforeEach(async () => {
            // carol first long 25 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // move to next block to simplify test case
            // otherwise we need to bring another trader to move the price further away

            await forwardTimestamp(clearingHouse)
        })

        it("carol's position is partially closed with given oppositeAmountBound", async () => {
            // We get deltaQuote as expected received quote through setting partialCloseRatio as 100% and callStatic closePosition.
            // Assume slippage is 1%, the oppositeAmountBound is calculated as below:
            // expected received quote * (1-slippage)
            // = 329.999999999999999997 * (1 - 0.01)
            // = 326.7
            const oppositeAmountBound = 326.7

            // remaining position size = 25 - (25 * 1/4) = 18.75
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: parseEther(oppositeAmountBound.toString()),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("18.75"))
        })
    })

    // https://docs.google.com/spreadsheets/d/1cVd-sM9HCeEczgmyGtdm1DH3vyoYEN7ArKfXx7DztEk/edit#gid=577678159
    describe("partial liquidate", () => {
        beforeEach(async () => {
            // carol first shorts 25 eth
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("25"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-25"))

            // liquidation can't happen in the same block because it's based on the index price
            await forwardTimestamp(clearingHouse)
        })

        it("taker's position is partially liquidated", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("10000000", 6), 0, 0, 0]
            })

            // should be partially liquidated
            // remaining position size = -25 - (-25 * 1/4) = -18.75
            await clearingHouse.connect(liquidator).liquidate(carol.address, baseToken.address)
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-18.75"))
        })

        // values are the same as the above one
        it("force error, partial liquidation/isOverPriceLimit can only happen once", async () => {
            mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                return [0, parseUnits("10000000", 6), 0, 0, 0]
            })
            await clearingHouse.connect(liquidator).liquidate(carol.address, baseToken.address)

            await expect(
                clearingHouse.connect(liquidator).liquidate(carol.address, baseToken.address),
            ).to.be.revertedWith("EX_AOPLO")
        })
    })

    // solution for bad debt attack
    // https://www.notion.so/perp/isOverPriceLimit-974202d798d746e69a3bbd0ee866926b?d=f9557a7434aa4c0a9a9fe92c4efee682#da5dee7be5e4465dbde04ce522b6711a
    // only check the price before swap here
    // it hits the limit only when
    //  1.the first short cause the price impact less than ~1.2%
    //    (the price impact of the remaining position after partial close will be less than 1%)
    //  2.because we have price check after swap, the PnL for the attacker will be very small.
    //    if the fee ratio is too large(1%), the attack can't get any benefit from CH
    //    So, the fee ratio must be small (haven't had a precious number)
    describe("bad debt attack: check price limit before swap", () => {
        beforeEach(async () => {
            // set fee ratio to 0.1%, it's easier to produce the attack
            await marketRegistry.setFeeRatio(baseToken.address, 1000)
            // move to next block to have finalTickLastBlock
            await forwardTimestamp(clearingHouse)
        })

        it("position closed partially, carol opens a short and alice open a large long which makes carol has bad debt", async () => {
            // 1. carol shorts 0.5 eth (price impact should be around 1.2%) and get quote 4.97, price now is 9.901
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 2. alice opens large long with 1000 quote and get base 50.325, price now is 39.742
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 3. carol can only close partial position, -(0.5 - 0.5/4) = -0.375
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-0.375"))

            // 4. alice can only close partial position, 50.33 - 50.33/4 = 37.7475
            await clearingHouse.connect(alice).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
                parseEther("37.762630707661446261"),
            )
        })

        it("force error, can not open a reverse pos, carol opens a short and alice open a large long which makes carol has bad debt", async () => {
            // 1. carol shorts 0.5 eth (price impact should be around 1.2%) and get quote 4.97, price now is 9.901
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.5"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 2. alice opens large long with 1000 quote and get base 50.325, price now is 39.742
            await clearingHouse.connect(alice).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1000"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 3. carol can only close partial position, -(0.5 - 0.5/4) = -0.375
            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).eq(parseEther("-0.375"))

            // 4. alice can not close her position through open a reverse position
            await expect(
                clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1000"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("EX_OPLBS")

            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).eq(
                parseEther("50.350174276881928348"),
            )
        })
    })
})
