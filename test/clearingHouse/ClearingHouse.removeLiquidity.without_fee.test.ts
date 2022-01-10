import { keccak256 } from "@ethersproject/solidity"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { initAndAddPool } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity without fee", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let exchange: Exchange
    let orderBook: OrderBook
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let collateralDecimals: number
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        quoteToken = fixture.quoteToken
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()
        baseAmount = parseUnits("100", await baseToken.decimals())
        quoteAmount = parseUnits("10000", await quoteToken.decimals())

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
    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1155466937
    describe("remove non-zero liquidity", () => {
        // @SAMPLE - removeLiquidity
        it("above current price", async () => {
            await initAndAddPool(
                fixture,
                pool,
                baseToken.address,
                encodePriceSqrt("151.373306858723226651", "1"),
                10000,
                // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                getMaxTickRange(),
            )

            // assume imRatio = 0.1
            // alice collateral = 1000, freeCollateral = 10,000, mint 100 base
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
            expect(quoteBalance).to.deep.eq(parseUnits("0", await quoteToken.decimals()))

            expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
            const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50200, 50400)
            expect(openOrder).to.deep.eq([
                BigNumber.from(0), // liquidity
                0, // lowerTick
                0, // upperTick
                parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                BigNumber.from("0"),
                BigNumber.from("0"),
            ])
        })

        it("force error, pool does not exist", async () => {
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
            ).to.be.revertedWith("EX_BTNE")
        })

        describe("initialized price = 151.373306858723226652", () => {
            beforeEach(async () => {
                await initAndAddPool(
                    fixture,
                    pool,
                    baseToken.address,
                    encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
                    10000,
                    // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
                    getMaxTickRange(),
                )
            })

            it("below current price", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 10,000 quote
                // will mint 10000 quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: 0,
                    quote: parseUnits("10000", await quoteToken.decimals()),
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
                        "-9999999999999999999999", // ~= -10,000
                        "-81689571696303801037492",
                        0,
                    )

                // verify account states
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    alice.address,
                    baseToken.address,
                )
                expect(baseBalance).to.deep.eq(parseUnits("0", await baseToken.decimals()))
                expect(quoteBalance).to.deep.eq(BigNumber.from("0"))

                expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.be.empty
                const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50200)
                expect(openOrder).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    BigNumber.from("0"),
                    BigNumber.from("0"),
                ])
            })

            it("at current price", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                // will mint x base and y quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
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
                        "-9999999999999999999999",
                        "-81689571696303801018159",
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
                expect(openOrder).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    BigNumber.from("0"),
                    BigNumber.from("0"),
                ])
            })

            it("twice", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                // will mint x base and y quote and transfer to pool
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
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
                expect(openOrder2).to.deep.eq([
                    BigNumber.from(0), // liquidity
                    0, // lowerTick
                    0, // upperTick
                    parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    BigNumber.from("0"),
                    BigNumber.from("0"),
                ])
            })

            it("force error, remove too much liquidity", async () => {
                // assume imRatio = 0.1
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
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
                // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
                await clearingHouse.connect(alice).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseUnits("100", await baseToken.decimals()),
                    quote: parseUnits("10000", await quoteToken.decimals()),
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

    it("remove zero liquidity; no swap no fee", async () => {
        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
            10000,
            // set maxTickCrossed as maximum tick range of pool by default, that means there is no over price when swap
            getMaxTickRange(),
        )

        // assume imRatio = 0.1
        // alice collateral = 1000, freeCollateral = 10,000, mint 100 base and 10000 quote
        // will mint x base and y quote and transfer to pool
        await clearingHouse.connect(alice).addLiquidity({
            baseToken: baseToken.address,
            base: parseUnits("100", await baseToken.decimals()),
            quote: parseUnits("10000", await quoteToken.decimals()),
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
        expect(baseBalance).to.deep.eq(parseUnits("-66.061845430469484023", await baseToken.decimals()))
        expect(quoteBalance).to.deep.eq(parseUnits("-10000", await quoteToken.decimals()))

        expect(await orderBook.getOpenOrderIds(alice.address, baseToken.address)).to.deep.eq([
            keccak256(["address", "address", "int24", "int24"], [alice.address, baseToken.address, 50000, 50400]),
        ])
        const openOrder = await orderBook.getOpenOrder(alice.address, baseToken.address, 50000, 50400)
        expect(openOrder).to.deep.eq([
            liquidity,
            50000, // lowerTick
            50400, // upperTick
            parseUnits("0", await baseToken.decimals()), // lastFeeGrowthInsideX128
            openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
            openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
            openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
            parseUnits("66.061845430469484023", await baseToken.decimals()),
            parseUnits("10000", await quoteToken.decimals()),
        ])
    })
})
