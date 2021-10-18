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

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918

    describe("one maker; initialized price = 151.373306858723226652", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
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
        })

        it("one taker swaps base to quote and then closes", async () => {
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

            // assure that the position of the taker is closed completely, and so is maker's position
            expect(await accountBalance.getPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getPositionSize(alice.address, baseToken.address)).to.eq(0)

            // taker sells all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

            // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
            const makerPnl = parseEther("0.001236480304009373")
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(makerPnl)

            // assure pnls of maker & taker are the same (of different sign)
            // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlTaker = (await accountBalance.getOwedAndUnrealizedPnl(bob.address))[0]
            // for maker, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlMaker = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[1]
            expect(owedRealizedPnlTaker.abs()).to.be.closeTo(owedOrUnrealizedPnlMaker.abs(), 10)
            expect(owedOrUnrealizedPnlMaker).to.eq(makerPnl)

            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: (
                    await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // after removing liquidity, maker's unrealizedPnl becomes owedRealizedPnl, thus getting the first element [0] of the array
            owedOrUnrealizedPnlMaker = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[0]
            expect(owedOrUnrealizedPnlMaker).to.eq(makerPnl)
        })

        it("two takers open position and then close; one maker", async () => {
            const base = parseEther("0.0004084104205")

            // bob & carol swap for the same amount in total as the above case
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: base.div(2),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: base.sub(base.div(2)),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob closes position first
            await clearingHouse.connect(bob).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await clearingHouse.connect(carol).closePosition({
                baseToken: baseToken.address,
                sqrtPriceLimitX96: 0,
                oppositeAmountBound: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // assure that position of takers are closed completely, and so is maker's position
            expect(await accountBalance.getPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getPositionSize(carol.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getPositionSize(alice.address, baseToken.address)).to.eq(0)

            // takers sell all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)
            expect(await accountBalance.getNetQuoteBalance(carol.address)).to.eq(0)

            // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
            const makerPnl = parseEther("0.001236480304009373")
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(makerPnl)

            // assure pnls of maker & takers are the same (of different sign)
            // for takers, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlBob = (await accountBalance.getOwedAndUnrealizedPnl(bob.address))[0]
            const owedRealizedPnlCarol = (await accountBalance.getOwedAndUnrealizedPnl(carol.address))[0]
            // as bob opens and also closes first, his pnl should be better than carol
            expect(owedRealizedPnlBob).to.be.gte(owedRealizedPnlCarol)

            // for maker, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlMaker = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[1]
            expect(owedRealizedPnlBob.add(owedRealizedPnlCarol).abs()).to.be.closeTo(owedOrUnrealizedPnlMaker.abs(), 10)
            expect(owedOrUnrealizedPnlMaker).to.eq(makerPnl)

            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: (
                    await orderBook.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // after removing liquidity, maker's unrealizedPnl becomes owedRealizedPnl, thus getting the first element [0] of the array
            owedOrUnrealizedPnlMaker = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[0]
            expect(owedOrUnrealizedPnlMaker).to.eq(makerPnl)
        })
    })

    // TODOs
    // one taker, one taker + maker, one maker -> same range
    // different range

    describe("two makers; initialized price = 148.3760629", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt(148.3760629, 1))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)
        })

        it("ranges are the same; alice receives 3/4 of fee, while carol receives only 1/4", async () => {
            const base = 0.000816820841

            // add base liquidity
            // 0.000816820841 * 3 = 0.002450462523
            const addLiquidityParamsAlice = {
                baseToken: baseToken.address,
                base: parseEther((base * 3).toString()),
                quote: "0",
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.002450462523 base to pool
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

            // add base liquidity
            const addLiquidityParamsCarol = {
                baseToken: baseToken.address,
                base: parseEther(base.toString()),
                quote: "0",
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.000816820841 base to pool
            await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

            // bob swap
            // quote: 0.112414646 / 0.99 = 0.1135501475
            // to base: 0.0007558893279
            const swapParams = {
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.1135501475"),
                sqrtPriceLimitX96: "0",
            }
            // will receive 0.0007558893279 base from pool
            await clearingHouse.connect(bob).swap(swapParams)

            // bob swap
            // base: 0.0007558893279
            // B2QFee: CH actually shorts 0.0007558893279 / 0.99 = 0.0007635245736 and get 0.112414646 quote
            // bob gets 0.112414646 * 0.99 = 0.1112904995
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
            expect(await accountBalance.getPositionSize(carol.address, baseToken.address)).to.eq(0)

            // taker sells all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

            // makers get 0.1135501475 * 0.01 + 0.112414646 * 0.01 = 0.002259647935
            const makersPnl = parseEther("0.00225964793525004")
            expect(
                (await accountBalance.getNetQuoteBalance(alice.address)).add(
                    await accountBalance.getNetQuoteBalance(carol.address),
                ),
            ).to.eq(makersPnl)

            // assure pnls of makers & taker are the same (of different sign)
            // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlTaker = (await accountBalance.getOwedAndUnrealizedPnl(bob.address))[0]
            // for makers, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlAlice = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[1]
            let owedOrUnrealizedPnlCarol = (await accountBalance.getOwedAndUnrealizedPnl(carol.address))[1]
            expect(owedRealizedPnlTaker.abs()).to.be.closeTo(
                owedOrUnrealizedPnlAlice.add(owedOrUnrealizedPnlCarol).abs(),
                10,
            )
            expect(owedOrUnrealizedPnlAlice.add(owedOrUnrealizedPnlCarol)).to.eq(makersPnl)
            // alice receives about 3 times the fee of carol
            expect(owedOrUnrealizedPnlAlice).to.be.closeTo(owedOrUnrealizedPnlCarol.mul(3), 10)
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
