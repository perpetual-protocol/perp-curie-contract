import { BigNumber } from "@ethersproject/bignumber"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse closePosition", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let lowerTick = "50000" // 148.3760629231
    let upperTick = "50200" // 151.3733068587

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        orderBook = _clearingHouseFixture.orderBook
        accountBalance = _clearingHouseFixture.accountBalance
        marketRegistry = _clearingHouseFixture.marketRegistry
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool

        const collateralDecimals = await collateral.decimals()
        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for bob
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 1000, collateral)

        // prepare collateral for carol
        await collateral.transfer(carol.address, amount)
        await deposit(carol, vault, 1000, collateral)
    })

    function sumArray(arr: BigNumber[]) {
        return arr.reduce((a, b) => a.add(b))
    }

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918

    it("one taker swaps base to quote and then closes; one maker", async () => {
        await pool.initialize(encodePriceSqrt(151.3733069, 1))
        // the initial number of oracle can be recorded is 1; thus, have to expand it
        await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

        // add pool after it's initialized
        await marketRegistry.addPool(baseToken.address, 10000)

        // alice add liquidity
        const addLiquidityParams = {
            baseToken: baseToken.address,
            base: "0",
            quote: parseEther("0.122414646"),
            lowerTick, // 148.3760629
            upperTick, // 151.3733069
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        }
        await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

        // bob swap
        // base: 0.0004084104205
        // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334175725025 quote
        // bob gets 0.06151334175725025 * 0.99 = 0.06089820833967775
        await clearingHouse.connect(bob).openPosition({
            baseToken: baseToken.address,
            isBaseToQuote: true,
            isExactInput: true,
            oppositeAmountBound: 0,
            amount: parseEther("0.0004084104205"),
            sqrtPriceLimitX96: "0",
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // taker pays 0.06151334175725025 / 0.99 = 0.06213468864 quote to pay back 0.0004084104205 base
        await clearingHouse.connect(bob).closePosition({
            baseToken: baseToken.address,
            sqrtPriceLimitX96: 0,
            oppositeAmountBound: 0,
            deadline: ethers.constants.MaxUint256,
            referralCode: ethers.constants.HashZero,
        })

        // assure that the position of the taker is close completely, and so is maker's position
        expect(await accountBalance.getPositionSize(bob.address, baseToken.address)).to.eq(0)
        expect(await accountBalance.getPositionSize(alice.address, baseToken.address)).to.eq(0)

        // taker sells all quote, making netQuoteBalance == 0
        expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

        // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
        const makerPnl = parseEther("0.001236480304009373")
        expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(makerPnl)

        // assure pnls of maker & taker are the same (of different sign)
        const owedAndUnrealizedPnlTaker = await accountBalance.getOwedAndUnrealizedPnl(bob.address)
        let owedAndUnrealizedPnlMaker = await accountBalance.getOwedAndUnrealizedPnl(alice.address)
        expect(sumArray(owedAndUnrealizedPnlTaker).abs()).to.be.closeTo(sumArray(owedAndUnrealizedPnlMaker).abs(), 10)

        // the fee maker gets is in unrealizedPnl
        expect(owedAndUnrealizedPnlMaker[1]).to.eq(makerPnl)

        await clearingHouse.connect(alice).removeLiquidity({
            baseToken: baseToken.address,
            lowerTick,
            upperTick,
            liquidity: (await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)).liquidity,
            minBase: 0,
            minQuote: 0,
            deadline: ethers.constants.MaxUint256,
        })

        owedAndUnrealizedPnlMaker = await accountBalance.getOwedAndUnrealizedPnl(alice.address)
        // after maker removes liquidity, the fee is in owedRealizedPnl
        expect(owedAndUnrealizedPnlMaker[0]).to.eq(makerPnl)
    })

    // TODO
    describe("takers and makers all close position", () => {
        it("two makers; alice receives 3/4 of fee, while carol receives only 1/4", async () => {
            await pool.initialize(encodePriceSqrt(148.3760629, 1))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)

            const base = 0.000816820841

            // add base liquidity
            // 0.000816820841 * 3 = 0.002450462523
            const addLiquidityParamsAlice = {
                baseToken: baseToken.address,
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                base: parseEther((base * 3).toString()),
                quote: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.002450462523 base to pool
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

            // add base liquidity
            const addLiquidityParamsCarol = {
                baseToken: baseToken.address,
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                base: parseEther(base.toString()),
                quote: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.000816820841 base to pool
            await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

            // liquidity ~= 3
            const liquidityAlice = (
                await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
            ).liquidity

            // liquidity ~= 1
            const liquidityCarol = (
                await orderBook.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
            ).liquidity

            // bob swap
            // quote: 0.112414646 / 0.99 = 0.1135501475
            // to base: 0.0007558893279
            const swapParams1 = {
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.1135501475"),
                sqrtPriceLimitX96: "0",
            }
            // will receive 0.0007558893279 base from pool
            await clearingHouse.connect(bob).swap(swapParams1)

            // bob swap; note that he does not use all base he gets to swap into quote here
            // base: 0.0007507052579
            // B2QFee: CH actually shorts 0.0007507052579 / 0.99 = 0.0007582881393 and get 0.1116454419 quote
            // bob gets 0.1116454419 * 0.99 = 0.1105289875
            const swapParams2 = {
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.0007507052579"),
                sqrtPriceLimitX96: "0",
            }
            // will transfer existing 0.0007507052579 base to pool
            // will receive 0.1116454419 quote from pool
            await clearingHouse.connect(bob).swap(swapParams2)

            // alice & carol both remove all their liquidity and should also both get fee
            const removeLiquidityParams = (liquidity: BigNumber) => ({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            const baseAlice = parseEther("0.002446574470343731")
            const quoteAlice = parseEther("0.000576903053000564")
            const feeAlice = parseEther("0.001688966920907494")

            // alice gets
            // base:  0.002450462523 (originally added) - (0.0007558893279 (bob gets) - 0.0007507052579 (bob sells)) * 3 / 4 = 0.00244657447
            // quote: (0.112414646 (bob pays) - 0.1116454419 (bob gets)) * 3 / 4 = 0.000576903075
            // fee:
            // expect 75% of 1 % of quote in ClearingHouse = 0.001116454419 * 0.75 = 0.0008373408142
            // expect 75% of 1% of quote in Uniswap = 0.001135501475 * 0.75 = 0.0008516261063
            // 0.0008373408142 + 0.0008516261063 = 0.00168896692
            await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams(liquidityAlice)))
                .to.emit(orderBook, "LiquidityChanged")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    quoteToken.address,
                    Number(lowerTick),
                    Number(upperTick),
                    baseAlice.mul(-1),
                    quoteAlice.mul(-1),
                    liquidityAlice.mul(-1),
                    feeAlice,
                )

            const baseCarol = parseEther("0.000815524823447910")
            const quoteCarol = parseEther("0.000192301017666854")
            const feeCarol = parseEther("0.000562988973635831")

            // carol gets
            // base:  0.000816820841 (originally added) - (0.0007558893279 (bob gets) - 0.0007507052579 (bob sells)) * 1 / 4 = 0.0008155248235
            // quote: (0.112414646 (bob pays) - 0.1116454419 (bob gets)) * 1 / 4 = 0.000192301025
            // fee:
            // expect 25% of 1 % of quote in ClearingHouse = 0.001116454419 * 0.25 = 0.0002791136048
            // expect 25% of 1% of quote = 0.001135501475 * 0.25 = 0.0002838753688
            // 0.0002791136048 + 0.0002838753688 = 0.0005629889736
            await expect(clearingHouse.connect(carol).removeLiquidity(removeLiquidityParams(liquidityCarol)))
                .to.emit(orderBook, "LiquidityChanged")
                .withArgs(
                    carol.address,
                    baseToken.address,
                    quoteToken.address,
                    Number(lowerTick),
                    Number(upperTick),
                    baseCarol.mul(-1),
                    quoteCarol.mul(-1),
                    liquidityCarol.mul(-1),
                    feeCarol,
                )

            // alice has -(0.002450462523 - 0.00244657447) = -0.000003888053 of position
            const [aliceBaseBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(aliceBaseBalance).to.deep.eq(parseEther("-0.000003888052656269"))

            // alice has 0.00168896692 quote from fees
            const [aliceOwedPnl] = await accountBalance.getOwedAndUnrealizedPnl(alice.address)
            expect(aliceOwedPnl).to.eq(feeAlice)

            // carol has -(0.000816820841 - 0.0008155248235) = -0.0000012960175 of position
            const [carolBaseBalance] = await clearingHouse.getTokenBalance(carol.address, baseToken.address)
            expect(carolBaseBalance).to.deep.eq(parseEther("-0.000001296017552090"))

            // carol has 0.0005629889737 quote from fees
            const [carolOwedPnl] = await accountBalance.getOwedAndUnrealizedPnl(carol.address)
            expect(carolOwedPnl).to.eq(feeCarol)
        })
    })

    describe("dust test for UniswapV3Broker.swap()", () => {
        // this test will fail if the _DUST constant in UniswapV3Broker is set to 1 (no dust allowed)
        it("a trader swaps base to quote and then closes; one maker", async () => {
            await pool.initialize(encodePriceSqrt(151.3733069, 1))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)

            // alice add liquidity
            const addLiquidityParams = {
                baseToken: baseToken.address,
                base: "0",
                quote: parseEther("0.122414646"),
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

            // bob swap
            // base: 0.0004084104205
            // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334175725025 quote
            // bob gets 0.06151334175725025 * 0.99 = 0.06089820833967775
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await clearingHouse.connect(bob).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // assure that the position of the taker is closed completely, and so is maker's position
            expect(await accountBalance.getPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getPositionSize(alice.address, baseToken.address)).to.eq(0)
        })
    })
})
