import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    MarketRegistry,
    OrderBook,
    TestClearingHouse,
    TestERC20,
    TestExchange,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { addOrder, closePosition, q2bExactInput, q2bExactOutput } from "../helper/clearingHouseHelper"
import { getMaxTick, getMinTick } from "../helper/number"
import { deposit } from "../helper/token"
import { forwardTimestamp } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse closePosition", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let orderBook: OrderBook
    let accountBalance: AccountBalance
    let exchange: TestExchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let lowerTick = "50000" // 148.3760629231
    let upperTick = "50200" // 151.3733068587
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(true))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        exchange = fixture.exchange as TestExchange
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool

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
                useTakerBalance: false,
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
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)

            // taker sells all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

            // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
            const pnlMaker = parseEther("0.001236480304009373")
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(pnlMaker)

            // assure pnls of maker & taker are the same (of different sign)
            // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlTaker = (await accountBalance.getOwedAndUnrealizedPnl(bob.address))[0]
            // for maker, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlMaker = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[1]
            expect(owedRealizedPnlTaker.abs()).to.be.closeTo(owedOrUnrealizedPnlMaker.abs(), 10)
            expect(owedOrUnrealizedPnlMaker).to.eq(pnlMaker)

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
            expect(owedOrUnrealizedPnlMaker).to.be.closeTo(pnlMaker, 1)
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
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)

            // takers sell all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)
            expect(await accountBalance.getNetQuoteBalance(carol.address)).to.eq(0)

            // maker gets 0.06151334175725025 * 0.01 + 0.06213468864 * 0.01 = 0.001236480304
            const pnlMaker = parseEther("0.001236480304009373")
            expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(pnlMaker)

            // assure pnls of maker & takers are the same (of different sign)
            // for takers, it's owedRealizedPnl, thus getting the first element [0] of the array
            const owedRealizedPnlBob = (await accountBalance.getOwedAndUnrealizedPnl(bob.address))[0]
            const owedRealizedPnlCarol = (await accountBalance.getOwedAndUnrealizedPnl(carol.address))[0]
            // as bob opens and also closes first, his pnl should be better than carol
            expect(owedRealizedPnlBob).to.be.gte(owedRealizedPnlCarol)

            // for maker, it's unrealizedPnl, thus getting the second element [1] of the array
            let owedOrUnrealizedPnlMaker = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[1]
            expect(owedRealizedPnlBob.add(owedRealizedPnlCarol).abs()).to.be.closeTo(owedOrUnrealizedPnlMaker.abs(), 10)
            expect(owedOrUnrealizedPnlMaker).to.eq(pnlMaker)

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
            expect(owedOrUnrealizedPnlMaker).to.be.closeTo(pnlMaker, 1)
        })
    })

    // different range
    describe("two makers; initialized price = 148.3760629", () => {
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt(148.3760629, 1))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)
        })

        it("ranges of makers are the same; alice receives 3/4 of fee, while carol receives only 1/4", async () => {
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
                useTakerBalance: false,
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
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            }
            // transfer 0.000816820841 base to pool
            await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

            // bob swap
            // quote: 0.112414646 / 0.99 = 0.1135501475
            // to base: 0.0007558893279
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("0.1135501475"),
                sqrtPriceLimitX96: "0",
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

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
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).to.eq(0)

            // taker sells all quote, making netQuoteBalance == 0
            expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

            // makers get 0.1135501475 * 0.01 + 0.112414646 * 0.01 = 0.002259647935
            const pnlMakers = parseEther("0.00225964793525004")
            expect(
                (await accountBalance.getNetQuoteBalance(alice.address)).add(
                    await accountBalance.getNetQuoteBalance(carol.address),
                ),
            ).to.eq(pnlMakers)

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
            expect(owedOrUnrealizedPnlAlice.add(owedOrUnrealizedPnlCarol)).to.eq(pnlMakers)
            // alice receives about 3 times the fee of carol
            expect(owedOrUnrealizedPnlAlice).to.be.closeTo(owedOrUnrealizedPnlCarol.mul(3), 10)
        })

        describe("one maker closes position before the taker closes", () => {
            it("ranges of makers are the same", async () => {
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
                    useTakerBalance: false,
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
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }
                // transfer 0.000816820841 base to pool
                await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                // bob swap
                // quote: 0.112414646 / 0.99 = 0.1135501475
                // to base: 0.0007558893279
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.1135501475"),
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                await clearingHouse.connect(carol).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: (
                        await orderBook.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // carol has 1/4 of the opposite position of bob = short 0.0007558893279 / 4 = 0.000188972332 base
                expect(
                    (await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).abs(),
                ).to.be.closeTo(
                    (await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).abs().div(4),
                    10,
                )

                // carol closes position
                // price before: 149.0615125299
                // x * y = l ^ 2 = 9
                // y / x = 149.0615125299
                // y ^ 2 = 1,341.5536127691
                // y = 36.62722502141
                // x = 0.24571886062
                // (0.24571886062 - 0.00018897233202709) * (36.62722502141 + y') = 9
                // y' = 0.02819018183
                // y' / 0.99 = 0.02847493114
                await clearingHouse.connect(carol).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                // price after: 149.2910515224
                // Verification:
                // 3 * (1 / sqrt(149.0615125299) - 1 / sqrt(149.2910515224)) = 0.000188972332
                // 3 * (sqrt(149.2910515224) - sqrt(149.0615125299)) = 0.02819018155 (imprecision)

                expect(await accountBalance.getTotalPositionSize(carol.address, baseToken.address)).to.eq(0)
                // netQuoteBalance == 0 after closing position
                expect(await accountBalance.getNetQuoteBalance(carol.address)).to.eq(0)

                let owedOrUnrealizedPnlCarol = (await accountBalance.getOwedAndUnrealizedPnl(carol.address))[0]
                // tx fee: 0.1135501475 * 0.01 * 0.25 = 0.0002838753688
                // quote: 0.1135501475 * 0.99 * 0.25 = 0.02810366151
                // quote paid for base: 0.02847493114
                // sum: 0.0002838753688 + 0.02810366151 - 0.02847493114 = -0.0000873942612 (imprecision)
                expect(owedOrUnrealizedPnlCarol).to.eq(parseEther("-0.000087393988262259"))

                // bob swap
                // base: 0.000755889328
                // B2QFee: CH actually shorts 0.000755889328 / 0.99 = 0.0007635245738
                // then Uniswap charges 0.0007635245738 * 0.01 = 0.000007635245738 as fee
                // y = 36.62722502141 + 0.02819018183 = 36.6554152032
                // x = 0.24571886062 - 0.000188972332 = 0.2455298883
                // (0.2455298883 + 0.0007635245738 * 0.99) * (36.6554152032 - y') = 9
                // y' = 0.1125011678
                // bob gets 0.1125011678 * 0.99 = 0.1113761561
                await clearingHouse.connect(bob).closePosition({
                    baseToken: baseToken.address,
                    sqrtPriceLimitX96: 0,
                    oppositeAmountBound: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                // price after: 148.3760629231
                // Verification:
                // 3 * (1 / sqrt(148.3760629231) - 1 / sqrt(149.2910515224)) = 0.0007558893281
                // 3 * (sqrt(149.2910515224) - sqrt(148.3760629231)) = 0.1125011661

                // assure that the position of the taker is closed completely, and so is maker's position
                expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
                expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)

                // taker sells all quote, making netQuoteBalance == 0
                expect(await accountBalance.getNetQuoteBalance(bob.address)).to.eq(0)

                // for taker, it's owedRealizedPnl, thus getting the first element [0] of the array
                let owedRealizedPnlTaker = (await accountBalance.getOwedAndUnrealizedPnl(bob.address))[0]
                // 0.1113761561 (bob gets when closing) - 0.1135501475 (bob pays when opening) = -0.0021739914
                expect(owedRealizedPnlTaker).to.eq(parseEther("-0.00217399308735427"))

                // for the only maker, it's unrealizedPnl, thus getting the second element [1] of the array
                let owedOrUnrealizedPnlAlice = (await accountBalance.getOwedAndUnrealizedPnl(alice.address))[1]
                // assure pnls of makers & takers are the same (of different sign)
                expect(owedOrUnrealizedPnlCarol.add(owedRealizedPnlTaker).add(owedOrUnrealizedPnlAlice)).to.be.closeTo(
                    "0",
                    10,
                )

                // alice get 0.1135501475 * 0.01 * 0.75 + (0.02847493114 + 0.1125011678) * 0.01 = 0.002261387096
                const pnlAlice = parseEther("0.002261387075616524")
                expect(await accountBalance.getNetQuoteBalance(alice.address)).to.eq(pnlAlice)
                expect(owedOrUnrealizedPnlAlice).to.eq(pnlAlice)
            })

            it("one maker close half liquidity and open position", async () => {
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
                    useTakerBalance: false,
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
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                }
                // transfer 0.000816820841 base to pool
                await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                // bob swap
                // quote: 0.112414646 / 0.99 = 0.1135501475
                // to base: 0.0007558893279
                await expect(
                    clearingHouse.connect(bob).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.1135501475"),
                        sqrtPriceLimitX96: "0",
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(accountBalance, "TakerBalancesChanged")
                    .withArgs(
                        bob.address,
                        baseToken.address,
                        parseEther("0.000755889328108358"),
                        parseEther("-0.1135501475"),
                    )

                const carolLiquidity = (
                    await orderBook.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                ).liquidity

                // carol has 25% liquidity of range
                // positionSize: -0.0007558893279 * 0.25 = -0.00018897233
                const carolPos = await accountBalance.getTotalPositionSize(carol.address, baseToken.address)
                expect(carolPos).to.be.eq(parseEther("-0.00018897233202709"))

                // carol get short position
                // carol's baseDebt: 0.000816820841
                // carol's quoteDebt: 0
                // carol's base in pool: 0.000816820841-0.00018897233 = 0.00062784851
                // carol's quote in pool: 0.112414646*0.25 = 0.0281036615
                // carol's deltaBaseDebt: 0.000816820841 / 2 = 0.00040841042
                // carol's deltaQuoteDebt: 0
                // deltaTakerBase: removedBase - deltaBaseDebt = (0.00062784851/2)- 0.00040841042 = -0.00009448616
                // deltaTakerQuote: removedQuote - deltaQuoteDebt = (0.0281036615/2)- 0 = 0.01405183075
                await expect(
                    clearingHouse.connect(carol).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: carolLiquidity.div(2),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(accountBalance, "TakerBalancesChanged")
                    .withArgs(
                        carol.address,
                        baseToken.address,
                        parseEther("-0.000094486166013545"),
                        parseEther("0.014051830753124999"),
                    )

                const carolTakerPos = await accountBalance.getTakerPositionSize(carol.address, baseToken.address)
                expect(carolTakerPos).to.be.eq(carolPos.div(2))
                expect(carolTakerPos).to.be.eq(parseEther("-0.000094486166013545"))

                // carol increases short position
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.0001"), // avoid out of liquidity
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                const carolTakerPos2 = await accountBalance.getTakerPositionSize(carol.address, baseToken.address)
                expect(carolTakerPos2).to.be.eq(carolTakerPos.add(parseEther("-0.0001")))

                // carol long
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.001"), // avoid out of liquidity
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                const carolTakerPos3 = await accountBalance.getTakerPositionSize(carol.address, baseToken.address)
                expect(carolTakerPos3).to.be.eq(carolTakerPos2.add(parseEther("0.001")))
            })
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
                useTakerBalance: false,
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
            expect(await accountBalance.getTotalPositionSize(bob.address, baseToken.address)).to.eq(0)
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.eq(0)
        })
    })

    describe("close position when user is maker and taker", async () => {
        let lowerTick: number, upperTick: number
        beforeEach(async () => {
            await pool.initialize(encodePriceSqrt(151.3733069, 1))
            // the initial number of oracle can be recorded is 1; thus, have to expand it
            await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

            // add pool after it's initialized
            await marketRegistry.addPool(baseToken.address, 10000)

            const tickSpacing = await pool.tickSpacing()
            lowerTick = getMinTick(tickSpacing)
            upperTick = getMaxTick(tickSpacing)
        })

        it("taker close position only effect taker position size", async () => {
            // alice add liquidity
            await addOrder(fixture, alice, 10, 1000, lowerTick, upperTick)

            // bob swap to let alice has maker impermanent position
            await q2bExactInput(fixture, bob, 100)

            // alice has maker position
            const totalPositionSize = await accountBalance.getTotalPositionSize(alice.address, baseToken.address)
            const takerPositionSize = await accountBalance.getTakerPositionSize(alice.address, baseToken.address)
            const makerPositionSize = totalPositionSize.sub(takerPositionSize)
            expect(makerPositionSize).to.be.lt(0)
            expect(takerPositionSize).to.be.eq(0)

            // alice has taker position, swap 100 quote to 0.49 base
            await q2bExactInput(fixture, alice, 100)
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                "496742576407532823",
            )
            // total position unchanged
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                totalPositionSize,
                1,
            )

            // alice close position
            await closePosition(fixture, alice)
            // taker position size is 0
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.lt(0)
            // total position(only maker) unchanged
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.closeTo(
                makerPositionSize,
                1,
            )
        })

        it("force error, alice has 0 taker position, close nothing", async () => {
            await addOrder(fixture, alice, 10, 1000, lowerTick, upperTick)

            // bob swap, alice has maker impermanent position
            await q2bExactInput(fixture, bob, 100)

            // alice has maker position and 0 taker position
            expect(await accountBalance.getTotalPositionSize(alice.address, baseToken.address)).to.be.lt(0)
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.eq(0)

            // alice close position
            await expect(closePosition(fixture, alice)).to.be.revertedWith("CH_PSZ")
        })

        it("reduce taker position and partial close", async () => {
            // set MaxTickCrossedWithinBlock so that trigger over price limit
            await exchange.setMaxTickCrossedWithinBlock(baseToken.address, 1000)

            // alice add liquidity
            await addOrder(fixture, alice, 10, 1000, lowerTick, upperTick)

            // bob swap let alice has maker position
            await q2bExactInput(fixture, bob, 10)

            // alice swap
            await q2bExactOutput(fixture, alice, 5)

            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("5"),
            )

            // alice partial close position, forward timestamp to bypass over price limit timestamp check
            await forwardTimestamp(clearingHouse, 3000)
            await closePosition(fixture, alice)

            // expect partial close 5 * 25% = 1.25
            expect(await accountBalance.getTakerPositionSize(alice.address, baseToken.address)).to.be.deep.eq(
                parseEther("3.75"),
            )
        })
    })
})
