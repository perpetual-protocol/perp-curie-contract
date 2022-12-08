import { MockContract } from "@eth-optimism/smock"
import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
} from "../../typechain"
import { addOrder, removeOrder } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { mintAndDeposit } from "../helper/token"
import { mockIndexPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity without fee", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let orderBook: OrderBook
    let collateral: TestERC20
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        await mintAndDeposit(fixture, alice, 10000)

        // prepare collateral for bob
        await mintAndDeposit(fixture, bob, 1000)

        // prepare collateral for carol
        await mintAndDeposit(fixture, carol, 1000)

        await mockIndexPrice(mockedPriceFeedDispatcher, "151")
    })

    it("remove zero liquidity; no swap no fee", async () => {
        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice)

        // assume imRatio = 0.1
        // alice collateral = 10000, freeCollateral = 100,000, mint 10 base and 1000 quote
        // will mint x base and y quote and transfer to pool
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseUnits("100"),
            quote: parseUnits("10000"),
            lowerTick: 50000,
            upperTick: 50400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        const liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)).liquidity

        // will receive no tokens from pool (no fees)
        await expect(
            clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 50000,
                upperTick: 50400,
                liquidity: 0,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            }),
        )
            .to.emit(clearingHouse, "LiquidityChanged")
            .withArgs(alice.address, baseToken.address, quoteToken.address, 50000, 50400, 0, 0, 0, 0)

        // verify account states
        // alice should have 100 - 33.9381545695 = 66.0618454305 debt
        const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
        expect(baseBalance).to.deep.eq(parseUnits("-66.061845430469484023"))
        expect(quoteBalance).to.deep.eq(parseUnits("-10000"))

        expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.deep.eq([
            keccak256(["address", "address", "int24", "int24"], [alice.address, baseToken.address, 50000, 50400]),
        ])
        const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
        expect(openOrder).to.deep.eq([
            liquidity,
            50000, // lowerTick
            50400, // upperTick
            parseUnits("0"), // lastFeeGrowthInsideX128
            openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
            openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
            openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
            parseUnits("66.061845430469484023"),
            parseUnits("10000"),
        ])
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("remove non-zero liquidity", () => {
        // @SAMPLE - removeLiquidity
        it("above current price", async () => {
            const initPrice = "151.373306858723226651"
            await initMarket(fixture, initPrice)

            // assume imRatio = 0.1
            // alice collateral = 10000, freeCollateral = 100,000, mint 100 base
            // will mint 100 base -> transfer to pool
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("100"),
                quote: 0,
                lowerTick: 50200,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            const liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)).liquidity

            // will receive 100 base from pool
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50200,
                    upperTick: 50400,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            )
                .to.emit(clearingHouse, "LiquidityChanged")
                .withArgs(
                    alice.address,
                    baseToken.address,
                    quoteToken.address,
                    50200,
                    50400,
                    "-99999999999999999999",
                    0,
                    "-123656206035422669342231",
                    0,
                )

            const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)
            expect(baseBalance).to.deep.eq(BigNumber.from(0))
            expect(quoteBalance).to.deep.eq(parseUnits("0"))

            expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
            const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            expect(openOrder.liquidity).be.eq(BigNumber.from("0"))
            expect(openOrder.lowerTick).be.eq(0)
            expect(openOrder.upperTick).be.eq(0)
            expect(openOrder.lastFeeGrowthInsideX128).be.eq(parseUnits("0", await baseToken.decimals()))
            expect(openOrder.baseDebt).be.eq(BigNumber.from("0"))
            expect(openOrder.quoteDebt).be.eq(BigNumber.from("0"))
        })

        it("force error, pool does not exist", async () => {
            // will reverted due to function selector was not recognized (IBaseToken(baseToken).getStatus)
            await expect(
                clearingHouse.connect(alice).removeLiquidity({
                    baseToken: collateral.address, // can't use quote token because _settleFunding would revert first
                    lowerTick: 0,
                    upperTick: 200,
                    liquidity: BigNumber.from(1),
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }),
            ).to.be.reverted
        })

        describe("initialized price = 151.373306858723226652", () => {
            beforeEach(async () => {
                const initPrice = "151.373306858723226652"
                await initMarket(fixture, initPrice)
            })

            it("below current price", async () => {
                // assume imRatio = 0.1
                // alice collateral = 10000, freeCollateral = 100,000, mint 10,000 quote
                // will mint 10000 quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseUnits("9999.999999999999999999", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50200,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                const liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200))
                    .liquidity

                // will receive 10000 quote from pool
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50200,
                        0,
                        "-9999999999999999999998", // ~= -10,000
                        "-81689571696303801037484",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).to.deep.eq(parseUnits("0"))
                expect(quoteBalance).to.deep.eq(BigNumber.from("0"))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
                expect(openOrder.liquidity).be.eq(BigNumber.from("0"))
                expect(openOrder.lowerTick).be.eq(0)
                expect(openOrder.upperTick).be.eq(0)
                expect(openOrder.lastFeeGrowthInsideX128).be.eq(parseUnits("0", await baseToken.decimals()))
                expect(openOrder.baseDebt).be.eq(BigNumber.from("0"))
                expect(openOrder.quoteDebt).be.eq(BigNumber.from("0"))
            })

            it("at current price", async () => {
                // assume imRatio = 0.1
                // alice collateral = 10000, freeCollateral = 100,000, mint 100 base and 10000 quote
                // will mint x base and y quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("9999.999999999999999999", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                const liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                // will receive x base and y quote from pool
                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity,
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                )
                    .to.emit(clearingHouse, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        50000,
                        50400,
                        parseUnits("-66.061845430469484022", await baseToken.decimals()),
                        "-9999999999999999999998",
                        "-81689571696303801018150",
                        0,
                    )

                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).to.deep.eq(BigNumber.from("0"))
                expect(quoteBalance).to.deep.eq(BigNumber.from("0"))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder.liquidity).be.eq(BigNumber.from("0"))
                expect(openOrder.lowerTick).be.eq(0)
                expect(openOrder.upperTick).be.eq(0)
                expect(openOrder.lastFeeGrowthInsideX128).be.eq(parseUnits("0", await baseToken.decimals()))
                expect(openOrder.baseDebt).be.eq(BigNumber.from("0"))
                expect(openOrder.quoteDebt).be.eq(BigNumber.from("0"))
            })

            it("twice", async () => {
                // assume imRatio = 0.1
                // alice collateral = 10000, freeCollateral = 100,000, mint 100 base and 10000 quote
                // will mint x base and y quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("9999.999999999999999999", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)

                const firstRemoveLiquidity = openOrder.liquidity.div(2)
                // will receive x/2 base and y/2 quote from pool
                await clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: firstRemoveLiquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                const openOrder1 = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder1.baseDebt).to.be.closeTo(openOrder.baseDebt.sub(openOrder.baseDebt.div(2)), 1)
                expect(openOrder1.quoteDebt).to.be.closeTo(openOrder.quoteDebt.sub(openOrder.quoteDebt.div(2)), 1)

                const secondRemoveLiquidity = openOrder.liquidity.sub(firstRemoveLiquidity)
                // will receive x/2 base and y/2 quote from pool
                await clearingHouse.connect(alice).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick: 50000,
                    upperTick: 50400,
                    liquidity: secondRemoveLiquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).to.deep.eq(BigNumber.from("0"))
                expect(quoteBalance).to.deep.eq(BigNumber.from("0"))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder2 = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
                expect(openOrder2.liquidity).be.eq(BigNumber.from("0"))
                expect(openOrder2.lowerTick).be.eq(0)
                expect(openOrder2.upperTick).be.eq(0)
                expect(openOrder2.lastFeeGrowthInsideX128).be.eq(parseUnits("0", await baseToken.decimals()))
                expect(openOrder2.baseDebt).be.eq(BigNumber.from("0"))
                expect(openOrder2.quoteDebt).be.eq(BigNumber.from("0"))
            })

            it("force error, remove too much liquidity", async () => {
                // assume imRatio = 0.1
                // alice collateral = 10000, freeCollateral = 100,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("9999.999999999999999999", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })
                const liquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400))
                    .liquidity

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50400,
                        liquidity: liquidity.add(1),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
            })

            it("force error, range does not exist", async () => {
                // assume imRatio = 0.1
                // alice collateral = 10000, freeCollateral = 100,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("9999.999999999999999999", await quoteToken.decimals()),
                    lowerTick: 50000,
                    upperTick: 50400,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                await expect(
                    clearingHouse.connect(alice).removeLiquidity({
                        baseToken: baseToken.address,
                        lowerTick: 50000,
                        upperTick: 50200,
                        liquidity: BigNumber.from(1),
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }),
                ).to.be.reverted
            })
        })
    })

    describe("baseToken and quoteToken are only transferred between uniswap pool and clearingHouse", async () => {
        let baseTokenBalanceInit, quoteTokenBalanceInit
        let baseTokenBalanceAddLiq, quoteTokenBalanceAddLiq

        beforeEach(async () => {
            const initPrice = "151.373306858723226652"
            await initMarket(fixture, initPrice)
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")

            baseTokenBalanceInit = await baseToken.balanceOf(clearingHouse.address)
            quoteTokenBalanceInit = await quoteToken.balanceOf(clearingHouse.address)
            expect(await baseTokenBalanceInit).to.be.not.eq(0)
            expect(await quoteTokenBalanceInit).to.be.not.eq(0)
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)

            // will mint x base and y quote and transfer to pool
            await addOrder(fixture, alice, 100, "9999.999999999999999999", 50000, 50400, false, baseToken.address)

            baseTokenBalanceAddLiq = await baseToken.balanceOf(clearingHouse.address)
            quoteTokenBalanceAddLiq = await quoteToken.balanceOf(clearingHouse.address)

            const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
            expect(baseTokenBalanceInit.sub(baseTokenBalanceAddLiq)).to.be.eq(openOrder.baseDebt)
            expect(quoteTokenBalanceInit.sub(quoteTokenBalanceAddLiq)).to.be.eq(openOrder.quoteDebt)
            // Should not transfer any token to exchange
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)
        })

        it("remove zero liquidity, should not transfer baseToken and quoteToken", async () => {
            await removeOrder(fixture, alice, 0, 50000, 50400)
            // Should not transfer any token to clearingHouse
            expect(await baseToken.balanceOf(clearingHouse.address)).to.be.eq(baseTokenBalanceAddLiq)
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.be.eq(quoteTokenBalanceAddLiq)

            // Should not transfer any token to exchange
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)
        })

        it("remove non-zero liquidity, should only transfer baseToken and quoteToken to cleaningHouse", async () => {
            const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
            await removeOrder(fixture, alice, openOrder.liquidity, 50000, 50400)

            // removeLiquidity might not return complete base and quote tokens back due to rounding issue
            expect(await baseToken.balanceOf(clearingHouse.address)).to.be.closeTo(baseTokenBalanceInit, 1)
            expect(await quoteToken.balanceOf(clearingHouse.address)).to.be.closeTo(quoteTokenBalanceInit, 1)

            // Should not transfer any token to exchange
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)
        })
    })
})
