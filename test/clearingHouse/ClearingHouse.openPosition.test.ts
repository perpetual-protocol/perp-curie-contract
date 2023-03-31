import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouseConfig,
    Exchange,
    MarketRegistry,
    OrderBook,
    QuoteToken,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { b2qExactOutput, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps } from "../shared/time"
import { encodePriceSqrt, mockIndexPrice, mockMarkPrice, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse openPosition", () => {
    const [admin, maker, maker2, taker, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let marketRegistry: MarketRegistry
    let clearingHouseConfig: ClearingHouseConfig
    let exchange: Exchange
    let orderBook: OrderBook
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let baseToken2: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let mockedPriceFeedDispatcher2: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        orderBook = fixture.orderBook
        accountBalance = fixture.accountBalance as TestAccountBalance
        clearingHouseConfig = fixture.clearingHouseConfig
        vault = fixture.vault
        exchange = fixture.exchange
        marketRegistry = fixture.marketRegistry
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        baseToken2 = fixture.baseToken2
        quoteToken = fixture.quoteToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        mockedPriceFeedDispatcher2 = fixture.mockedPriceFeedDispatcher2
        pool = fixture.pool
        collateralDecimals = await collateral.decimals()

        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice, undefined, 0)
        await mockIndexPrice(mockedPriceFeedDispatcher, "151")

        await initMarket(fixture, initPrice, undefined, 0, undefined, baseToken2.address)
        await mockIndexPrice(mockedPriceFeedDispatcher2, "151")

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await collateral.mint(maker2.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)
        await deposit(maker2, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("65.943787"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // maker
        //   pool.base = 65.9437860798
        //   pool.quote = 10000
        //   liquidity = 884.6906588359
        //   virtual base liquidity = 884.6906588359 / sqrt(151.373306858723226652) = 71.9062751863
        //   virtual quote liquidity = 884.6906588359 * sqrt(151.373306858723226652) = 10884.6906588362

        // prepare collateral for taker
        const takerCollateral = parseUnits("1000", collateralDecimals)
        await collateral.mint(taker.address, takerCollateral)
        await collateral.connect(taker).approve(clearingHouse.address, takerCollateral)
    })

    async function getMakerFee(): Promise<BigNumber> {
        return (
            await clearingHouse.connect(maker).callStatic.removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: lowerTick,
                upperTick: upperTick,
                liquidity: 0,
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
        ).fee
    }

    describe("invalid input", () => {
        describe("taker has enough collateral", () => {
            beforeEach(async () => {
                await deposit(taker, vault, 1000, collateral)
            })

            it("force error due to invalid baseToken", async () => {
                // will reverted due to function selector was not recognized (IBaseToken(baseToken).getStatus)
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: pool.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.reverted
            })

            it("force error due to invalid amount (0)", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: 0,
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.reverted
            })

            it("force error due to slippage protection", async () => {
                // taker want to get 1 vETH in exact current price which is not possible
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: 1,
                        sqrtPriceLimitX96: encodePriceSqrt("151.373306858723226652", "1"),
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("SPL")
            })

            it("force error due to not enough liquidity", async () => {
                // empty the liquidity
                const order = await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick)
                await clearingHouse.connect(maker).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: order.liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })

                // trade
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: 1,
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_F0S")
            })
        })
    })

    describe("taker has 0 collateral", () => {
        // using formula: https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f#d3d12da52d4c455999dcca491a1ba34d
        const calcQuoteAmountForLong = (marketPrice: number, indexPrice: number, liquidity: number): number => {
            return (indexPrice * liquidity * 0.9 - marketPrice * liquidity) / Math.sqrt(marketPrice) / 10 ** 18 - 1
        }
        // using formula: https://www.notion.so/perp/Index-price-spread-attack-2f203d45b34f4cc3ab80ac835247030f#a14db12f09404b0bb43242be5a706179
        const calcQuoteAmountForShort = (marketPrice: number, indexPrice: number, liquidity: number): number => {
            return (
                (0.9 * marketPrice * liquidity - indexPrice * liquidity) / (0.9 * Math.sqrt(marketPrice)) / 10 ** 18 - 1
            )
        }
        beforeEach(async () => {
            // set fee ratio to 0
            await marketRegistry.setFeeRatio(baseToken.address, 0)
        })
        describe("market price lesser than index price", () => {
            beforeEach(async () => {
                // the index price must be larger than (market price / 0.9) = 151 / 0.9 ~= 167
                // market price = 151.373306858723226652
                // index price = 170
                // liquidity = 884690658835870366575
                await mockIndexPrice(mockedPriceFeedDispatcher, "170")
            })
            it("force error, Q2B, due to not enough collateral for mint", async () => {
                const quoteAmount = calcQuoteAmountForLong(
                    151.373306858723226652,
                    170,
                    884690658835870366575,
                ).toString()
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther(quoteAmount),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEFCI")
            })

            it("force error, B2Q, due to not enough collateral for mint", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.001"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEFCI")
            })
        })

        describe("market price larger than index price", () => {
            beforeEach(async () => {
                // the index price must be lesser than (market price * 0.9) = 151 * 0.9 ~= 135.9
                // market price = 151.373306858723226652
                // index price = 133
                // liquidity = 884690658835870366575
                await mockIndexPrice(mockedPriceFeedDispatcher, "133")
            })
            it("force error, Q2B, due to not enough collateral for mint", async () => {
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.001"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEFCI")
            })

            it("force error, B2Q, due to not enough collateral for mint", async () => {
                const quoteAmount = calcQuoteAmountForShort(
                    151.373306858723226652,
                    133,
                    884690658835870366575,
                ).toString()
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther(quoteAmount),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                ).to.be.revertedWith("CH_NEFCI")
            })
        })
    })

    describe("taker open position from zero", async () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
        })

        describe("long", () => {
            it("verify base and quote amount in static call", async () => {
                // taker swap 1 USD for 6539527905092835/10^18 ETH
                const response = await clearingHouse.connect(taker).callStatic.openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })
                expect(response.base).to.be.eq("6539527905092835")
                expect(response.quote).to.be.eq("1000000000000000000")
            })

            it("increase ? position when exact input", async () => {
                // taker swap 1 USD for ? ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        "6539527905092835", // exchangedPositionSize
                        parseEther("-0.99"), // exchangedPositionNotional
                        parseEther("0.01"), // fee = 1 * 0.01
                        parseEther("-1"), // openNotional
                        parseEther("0"), // realizedPnl
                        "974863323923301853330898562804", // sqrtPriceAfterX96
                    )
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )
                expect(baseBalance).be.gt(parseEther("0"))
                expect(quoteBalance).be.deep.eq(parseEther("-1"))

                expect(await getMakerFee()).be.closeTo(parseEther("0.01"), 1)

                expect(await accountBalance.getTakerPositionSize(taker.address, baseToken.address)).to.be.eq(
                    "6539527905092835",
                )
            })

            it("increase 1 long position when exact output", async () => {
                // taker swap ? USD for 1 ETH -> quote to base -> fee is charged before swapping
                //   exchanged notional = 71.9062751863 * 10884.6906588362 / (71.9062751863 - 1) - 10884.6906588362 = 153.508143394
                //   taker fee = 153.508143394 / 0.99 * 0.01 = 1.550587307

                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("1"), // exchangedPositionSize
                        "-153508143394151325059", // exchangedPositionNotional
                        "1550587307011629547", // fee
                        "-155058730701162954606", // openNotional
                        parseEther("0"), // realizedPnl
                        "988522032908775036581348357236", // sqrtPriceAfterX96
                    )

                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseEther("1"))
                expect(quoteBalance).be.lt(parseEther("0"))

                expect(await getMakerFee()).be.closeTo(parseEther("1.550587307011629547"), 1)
            })
        })
        describe("short", () => {
            it("increase position from 0, exact input", async () => {
                // taker swap 1 ETH for ? USD -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
                //   taker fee = 149.2970341856 * 0.01 = 1.492970341856

                // taker swap 1 ETH for ? USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-1"), // exchangedPositionSize
                        parseEther("149.297034185732877727"), // exchangedPositionNotional
                        parseEther("1.492970341857328778"), // fee: 149.297034185732877727 * 0.01 = 1.492970341857328777
                        parseEther("147.804063843875548949"), // openNotional
                        parseEther("0"), // realizedPnl
                        "961404421142614700863221952241", // sqrtPriceAfterX96
                    )
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )

                expect(baseBalance).be.deep.eq(parseEther("-1"))
                expect(quoteBalance).be.gt(parseEther("0"))

                expect(await getMakerFee()).be.closeTo(parseEther("1.492970341857328777"), 1)
            })

            it("increase position from 0, exact output", async () => {
                // taker swap ? ETH for 1 USD -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 71.9062751863 - 71.9062751863 * 10884.6906588362 / (10884.6906588362 - 1)
                //                           = -0.006606791523
                //   taker fee = 1 / (0.99) * 0.01 = 0.0101010101

                // taker swap ? ETH for 1 USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: false,
                        oppositeAmountBound: 0,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                        deadline: ethers.constants.MaxUint256,
                        referralCode: ethers.constants.HashZero,
                    }),
                )
                    .to.emit(clearingHouse, "PositionChanged")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-0.006673532984759078"), // exchangedPositionSize
                        parseEther("1.010101010101010102"), // exchangedPositionNotional
                        parseEther("0.010101010101010102"), // fee
                        parseEther("1"), // openNotional
                        parseEther("0"), // realizedPnl
                        "974684205576916525762591342066", // sqrtPriceAfterX96
                    )

                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )
                expect(baseBalance).be.lt(parseEther("0"))
                expect(quoteBalance).be.deep.eq(parseEther("1"))

                expect(await getMakerFee()).be.closeTo(parseEther("0.010101010101010102"), 1)
                expect(await accountBalance.getTakerPositionSize(taker.address, baseToken.address)).to.be.eq(
                    parseEther("-0.006673532984759078"),
                )
            })
        })
    })

    describe("opening long first then", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)

            // 71.9062751863 - 884.6906588359 ^ 2  / (10884.6906588362 + 2 * 0.99) = 0.01307786649
            // taker swap 2 USD for 0.01307786649 ETH
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // virtual base liquidity = 71.9062751863 - 0.01307786649 = 71.8931973198
            // virtual quote liquidity = 10884.6906588362 + 2 * 0.99 = 10886.6706588362
        })

        it("increase position", async () => {
            const [baseBalanceBefore, quoteBalanceBefore] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            // taker swap 1 USD for ? ETH again
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase ? USD debt, increase 1 ETH available, the rest remains the same
            const [baseBalanceAfter, quoteBalanceAfter] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )
            const baseBalanceDelta = baseBalanceAfter.sub(baseBalanceBefore)
            const quoteBalanceDelta = quoteBalanceAfter.sub(quoteBalanceBefore)
            expect(baseBalanceDelta).be.gt(parseEther("0"))
            expect(quoteBalanceDelta).be.deep.eq(parseEther("-1"))

            // pos size: 0.01961501593
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "19615015933642630",
            )
            expect((await accountBalance.getNetQuoteBalanceAndPendingFee(taker.address))[0]).to.eq(parseEther("-3"))

            // (2 (beforeEach) + 1 (now)) * 1% = 0.03
            expect(await getMakerFee()).be.closeTo(parseEther("0.03"), 1)

            expect(await accountBalance.getTakerPositionSize(taker.address, baseToken.address)).to.be.eq(
                "19615015933642630",
            )
        })

        it("can increase position when profit > 0", async () => {
            // this test is to fix a bug of the formula of _getTotalMarginRequirement():
            // when a position has a profit, the freeCollateral becomes less and thus cannot increase position

            // mock index price to market price
            await mockIndexPrice(mockedPriceFeedDispatcher, "382395")

            // indexPrice = p -> positionValue = 0.026150976705867546 * p
            // pnl = 0.026150976705867546 * p - 4
            // totalMarginRequirement = max(0.026150976705867546 * p, 4) * 10%
            // freeCollateral = min(1000, > 1000) - totalMarginRequirement = 1000 - 0.026150976705867546 * p * 10%
            // when p > 382,394.895321683, freeCollateral < 0

            // increase position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "26150976705867546",
            )
        })

        it("reduce position", async () => {
            const [baseBalanceBefore, quoteBalanceBefore] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            // reduced base = 0.006538933220746360
            const reducedBase = baseBalanceBefore.div(2)
            // taker reduce 50% ETH position for ? USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: reducedBase,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase ? USD available, reduce 1 ETH available, the rest remains the same
            const [baseBalanceAfter, quoteBalanceAfter] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )
            const baseBalanceDelta = baseBalanceAfter.sub(baseBalanceBefore)
            const quoteBalanceDelta = quoteBalanceAfter.sub(quoteBalanceBefore)
            expect(baseBalanceDelta).be.deep.eq(-reducedBase)
            expect(quoteBalanceDelta).be.gt(parseEther("0"))

            // pos size: 0.006538933220746361
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "6538933220746361",
            )
            expect((await accountBalance.getNetQuoteBalanceAndPendingFee(taker.address))[0]).to.eq(quoteBalanceAfter)
            expect(await accountBalance.getTakerPositionSize(taker.address, baseToken.address)).to.be.eq(
                "6538933220746361",
            )
        })

        it("reduce position and at the same side when margin ratio is smaller than imRatio and greater than mmRatio", async () => {
            await vault.connect(taker).withdraw(collateral.address, parseUnits("999.6", collateralDecimals))

            await mockMarkPrice(accountBalance, baseToken.address, "133")
            const positionSize = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)
            const freeCollateralByImRatio = await vault.getFreeCollateralByRatio(
                taker.address,
                await clearingHouseConfig.getImRatio(),
            )
            const freeCollateralByMmRatio = await vault.getFreeCollateralByRatio(
                taker.address,
                await clearingHouseConfig.getMmRatio(),
            )
            expect(freeCollateralByImRatio).to.be.lt(0)
            expect(freeCollateralByMmRatio).to.be.gt(0)

            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: 1,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            const positionSizeAfter = await accountBalance.getTotalPositionSize(taker.address, baseToken.address)

            expect(positionSizeAfter).to.be.eq(positionSize.sub(1))
        })

        it("reduce position and at the different side", async () => {
            // 1000 - 999.6 = 0.4 as collateral
            await vault.connect(taker).withdraw(collateral.address, parseUnits("999.6", collateralDecimals))

            // case 1: check reducing position when existing position is long
            // free collateral 0.17
            // reverse position with amount exceeds initial margin
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("6"), // greater than (0.2*2+0.17) * 10, smaller than 0.4 * 16 (mmRatio)
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_NEFCI")

            // case 2: check reducing position when existing position is short
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("4"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // free collateral 0.13
            const freeCollateralByImRatioAfter = await vault.getFreeCollateralByRatio(
                taker.address,
                await clearingHouseConfig.getImRatio(),
            )

            const positionSize = await accountBalance.getTakerPositionSize(taker.address, baseToken.address)

            expect(freeCollateralByImRatioAfter).to.be.gt(0)
            expect(positionSize).to.be.lt(0)

            // reverse position with amount exceeds initial margin
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("5.5"), // greater than (0.13+0.2*2) * 10, smaller than 0.4 * 16 (mmRatio)
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_NEFCI")
        })

        it("close position, base's available/debt will be 0, settle to owedRealizedPnl", async () => {
            // expect taker has 2 USD worth ETH
            const [baseBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
            const posSize = baseBalance
            // posSize = 0.013077866441492721

            // taker sells 0.013077866441492721 ETH
            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     10886.6706588362 - 884.6906588359 ^ 2 / (71.8931973198 + 0.013077866441492721) = 1.98000000000026751159
            // taker gets 1.98000000000026751159 * 0.99 = 1.9602000000002648364741
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // base balance will be 0
            {
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseEther("0"))
                expect(quoteBalance).be.deep.eq(parseEther("0"))

                // 2 - 1.9602000000002648364741 = 0.0398000015
                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).eq(parseEther("-0.039800000000000043")) // fee loss
            }

            // free collateral will be less than original number bcs of fees
            // 1000 - 0.039800000000000043 = 999.9602
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("999.960199", 6))

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq("0")
            expect(await accountBalance.getTakerPositionSize(taker.address, baseToken.address)).to.be.eq("0")

            // response.exchangedPositionSize
            // 13077866441492721
            // response.exchangedPositionNotional
            // -1980000000000000000
            // response.exchangedPositionSize
            // -13077866441492721
            // response.exchangedPositionNotional
            // 1979999999999999957
        })

        it("close position with profit", async () => {
            // expect taker has 2 USD worth ETH
            const [baseBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
            const posSize = baseBalance
            // posSize = 0.013077866441492721

            // prepare collateral for carol
            const carolAmount = parseEther("1000")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol pays $1000 for ETH long
            // 71.8931973198 - 884.6906588359 ^ 2 / (10886.6706588362 + 990) = 5.9927792385
            await mockIndexPrice(mockedPriceFeedDispatcher, "180")
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            // virtual base liquidity = 71.8931973198 - 5.9927792385 = 65.9004180813
            // virtual quote liquidity = 10886.6706588362 + 990 = 11876.6706588362

            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     11876.6706588362 - 884.6906588359 ^ 2 / (65.9004180813 + 0.013077866441492721) = 2.3564447634
            // taker gets 2.3564447634 * 0.99 = 2.3328803158
            await mockIndexPrice(mockedPriceFeedDispatcher, "151")
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // mock index price to market price
            await mockIndexPrice(mockedPriceFeedDispatcher, "103.12129")

            // base debt and available will be 0
            {
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseEther("0"))
                expect(quoteBalance).be.deep.eq(parseEther("0"))

                // pnl = 2.3328803158 - 2 = 0.3328803158
                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).deep.eq(parseEther("0.332880320006927809"))
            }

            // collateral will be less than original number bcs of fees
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("1000.33288", 6))

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("close position with loss", async () => {
            // expect taker has 2 USD worth ETH
            const [baseBalance] = await clearingHouse.getTokenBalance(taker.address, baseToken.address)
            const posSize = baseBalance

            // prepare collateral for carol
            const carolAmount = parseEther("1000")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol pays for $1000 ETH short
            // B2QFee: CH actually gets 1000 / 0.99 = 1010.101010101 quote
            // 884.6906588359 ^ 2 / (10886.6706588362 - 1010.101010101) - 71.8931973198 = 7.3526936796
            await mockIndexPrice(mockedPriceFeedDispatcher, "124")
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // 0.0130787866

            // virtual base liquidity = 71.8931973198 + 7.3526936796 = 79.2458909994
            // virtual quote liquidity = 10886.6706588362 - 1010.101010101 = 9876.5696487352

            // CH will boost the ETH amount in, but then pool will cut the exact percentage as fee,
            //   so the actual swapped in amount is still 0.013077866441492721
            //   amount out would be:
            //     9876.5696487352 - 884.6906588359 ^ 2 / (79.2458909994 + 0.013077866441492721) = 1.6296510132
            // taker gets 1.6296510132 * 0.99 = 1.6133545031
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // base debt and available will be 0
            {
                const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(
                    taker.address,
                    baseToken.address,
                )
                expect(baseBalance).be.deep.eq(parseEther("0"))
                expect(quoteBalance).be.deep.eq(parseEther("0"))

                // pnl = 1.6133545031 -2 = -0.3866454969
                const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
                expect(pnl[0]).deep.eq(parseEther("-0.386645498819609266"))
            }

            // collateral will be less than original number bcs of fees
            const freeCollateral = await vault.getFreeCollateral(taker.address)
            expect(freeCollateral).deep.eq(parseUnits("999.613354", collateralDecimals))

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq("0")
        })

        it("open larger reverse position", async () => {
            // taker has 2 USD worth ETH long position
            // then opens 10 USD worth ETH short position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // position size = -0.05368894844
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "-53688948443543907",
            )

            // openNotional = 8.0412624948
            expect(await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)).to.eq(
                "8041262494847024252",
            )

            // realizedPnl = -0.04126249485
            const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(pnl[0]).to.eq("-41262494847024252")
        })

        // TODO: blocked by TWAP based _getDebtValue
        it.skip("force error, can't open another long if it's under collateral", async () => {
            // prepare collateral for carol
            const carolAmount = parseUnits("1000", collateralDecimals)
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 1000, collateral)

            // carol open short to make taker under collateral
            await clearingHouse.connect(carol).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: carolAmount,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // taker want to increase position but he's under collateral
            // TODO expect taker's margin ratio < mmRatio
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: 1,
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("CH_CNE")
        })
    })

    describe("opening short first then", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
            // taker swap ? ETH for 2 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("2"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
        })
        it("increase position", async () => {
            const [baseBalanceBefore, quoteBalanceBefore] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            // taker swap ? ETH for 1 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase 1 USD debt, increase ? ETH balance
            const [baseBalanceAfter, quoteBalanceAfter] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )
            const baseBalanceDelta = baseBalanceAfter.sub(baseBalanceBefore)
            const quoteBalanceDelta = quoteBalanceAfter.sub(quoteBalanceBefore)
            expect(baseBalanceDelta).be.lt(parseEther("0"))
            expect(quoteBalanceDelta).be.deep.eq(parseEther("1"))

            // pos size: -0.02002431581853605
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "-20024315818536050",
            )
            expect((await accountBalance.getNetQuoteBalanceAndPendingFee(taker.address))[0]).to.eq(parseEther("3"))

            // ((2 (beforeEach) + 1 (now)) / 0.99 )* 1% = 0.030303030303030304
            expect(await getMakerFee()).be.closeTo(parseEther("0.030303030303030304"), 1)
        })

        it("reduce position", async () => {
            const [baseBalanceBefore, quoteBalanceBefore] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            // baseBalance = -13348304809274554 (< 0 when short)
            // reducedBase = 6674152404637277
            const reducedBase = baseBalanceBefore.div(2).mul(-1)

            // taker reduce 50% ETH position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: reducedBase,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase ? USD debt, decrease 50% ETH balance
            const [baseBalanceAfter, quoteBalanceAfter] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            const baseBalanceDelta = baseBalanceAfter.sub(baseBalanceBefore)
            const quoteBalanceDelta = quoteBalanceAfter.sub(quoteBalanceBefore)
            expect(baseBalanceDelta).be.deep.eq(reducedBase)
            expect(quoteBalanceDelta).be.deep.eq(parseEther("-1"))

            // pos size: baseBalanceBefore / 2 = reducedBase
            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(-reducedBase)
            expect((await accountBalance.getNetQuoteBalanceAndPendingFee(taker.address))[0]).to.eq(parseEther("1"))

            // fee = 0.030404113776447206
            expect(await getMakerFee()).be.deep.eq(parseEther("0.030404113776447206"))
        })

        it("close position", async () => {
            const [baseBalanceBefore, quoteBalanceBefore] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            // posSize = baseBalance = -13348304809274554 (< 0 when short)
            const posSize = baseBalanceBefore.mul(-1)

            // taker reduce 100% ETH position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: posSize,
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // increase ? USD debt, decrease 100% ETH balance
            const [baseBalanceAfter, quoteBalanceAfter] = await clearingHouse.getTokenBalance(
                taker.address,
                baseToken.address,
            )

            const baseBalanceDelta = baseBalanceAfter.sub(baseBalanceBefore)
            const quoteBalanceDelta = quoteBalanceAfter.sub(quoteBalanceBefore)
            expect(baseBalanceDelta).be.deep.eq(posSize)
            expect(quoteBalanceDelta).be.deep.eq(parseEther("-2"))

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq("0")
            expect((await accountBalance.getNetQuoteBalanceAndPendingFee(taker.address))[0]).to.eq(parseEther("0"))

            // fee = 0.040608101214161821
            expect(await getMakerFee()).be.deep.eq(parseEther("0.040608101214161821"))
        })

        it("open larger reverse position", async () => {
            // taker has 2 USD worth ETH short position
            // then opens 10 USD worth ETH long position
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("10"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            expect(await accountBalance.getTotalPositionSize(taker.address, baseToken.address)).to.eq(
                "52017742202701754",
            )

            // because taker opens a larger reverse position, her position is closed and increase a new one
            // she spent $8 for the 2nd tx, openNotional = -8 - realizedPnlBcsOfFeeFromPrevTx
            const openNotional = await accountBalance.getTotalOpenNotional(taker.address, baseToken.address)
            const pnl = await accountBalance.getPnlAndPendingFee(taker.address)
            expect(openNotional).to.eq("-7957914633138379981")
            expect(openNotional).to.eq(parseEther("-8").sub(pnl[0]))
        })
    })

    // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=1258612497
    describe("maker has order out of price range", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
            // maker2 add liquidity out of price range
            await clearingHouse.connect(maker2).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("0"),
                quote: parseEther("100"),
                lowerTick: 50000,
                upperTick: 50200,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })
        })

        it("will not affect her range order", async () => {
            // taker open position will not effect maker2's position
            const maker2PositionSizeBefore = await accountBalance.getTotalPositionSize(
                maker2.address,
                baseToken.address,
            )

            // taker long 1 USD
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            const maker2PositionSizeAfter = await accountBalance.getTotalPositionSize(maker2.address, baseToken.address)

            expect(maker2PositionSizeBefore).to.deep.eq(maker2PositionSizeAfter)
        })
    })

    describe("maker has order within price range", () => {
        it("will not affect her range order if maker and trader is the same person", async () => {
            // maker and trader is the same person, openPosition will not change her positionSize
            const makerPositionSizeBefore = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)
            // maker long 1 USD
            await clearingHouse.connect(maker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false, // quote to base
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })
            const makerPositionSizeAfter = await accountBalance.getTotalPositionSize(maker.address, baseToken.address)

            expect(makerPositionSizeBefore).to.deep.eq(makerPositionSizeAfter)
        })
    })

    describe("markets number exceeded", () => {
        beforeEach(async () => {
            await clearingHouse.connect(maker).addLiquidity({
                baseToken: baseToken2.address,
                base: parseEther("65.943787"),
                quote: parseEther("10000"),
                lowerTick,
                upperTick,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            await deposit(taker, vault, 1000, collateral)
            await clearingHouseConfig.setMaxMarketsPerAccount("1")
        })
        it("after closing position on market A, could open on market B ", async () => {
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // close market of baseToken
            await clearingHouse.connect(taker).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.emit(clearingHouse, "PositionChanged")
        })

        it("force error, markets number exceeded", async () => {
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.emit(clearingHouse, "PositionChanged")

            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).to.be.revertedWith("AB_MNE")
        })
    })

    describe("taker become maker", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 100, collateral)

            const carolAmount = parseEther("100")
            await collateral.connect(admin).mint(carol.address, carolAmount)
            await deposit(carol, vault, 100, collateral)
        })

        describe("long first then add liquidity", async () => {
            let freeCollateralBefore: string

            beforeEach(async () => {
                // taker swap 2 USD for 0.013077866441492721 ETH
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                freeCollateralBefore = (await vault.getFreeCollateral(taker.address)).toString()
                // free collateral = min(collateral, account value) - total debt * imRatio
                //                 = min(100, 100 + (-0.692213355850727900)) - 0.2
                //                 = 100 + (-0.692213355850727900) - 0.2
                //                 = 99.107786

                // remove other maker liquidity to simplify the following tests
                const liquidity = (await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick))
                    .liquidity
                await clearingHouse.connect(maker).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            })

            it("add liquidity above the current tick", async () => {
                await clearingHouse.connect(taker).addLiquidity({
                    baseToken: baseToken.address,
                    base: parseEther("0.013077866441492721"),
                    quote: parseEther("0"),
                    lowerTick: 50400,
                    upperTick: 50600,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                let freeCollateral = (await vault.getFreeCollateral(taker.address)).toString()

                expect(freeCollateral).to.be.eq(freeCollateralBefore)

                // swap by carol
                // swap 2 USD for 0.012697396035898852 ETH
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // {
                //     indexPrice: '151.0',
                //     markPrice: '151.373306858723226651',
                //     marketPrice: '157.458567281999000245'
                // }

                // openNotional = quoteBalance + (quoteLiquidity + quoteFee) = (-2) + (2) = 0
                // positionValue = (0.013077866441492721 - 0.013077866441492721 + 0.000380470405593868) * 151.373306858723226651 = 0.05759306346
                // unrealizedPnL = positionValue + openNotional = 0.05759306346 + 0 = 0.05759306346
                // total debt = 2
                // fee = 2 * 0.01 = 0.02
                // free collateral = min(collateral + fee, account value) - total debt * imRatio
                // free collateral = min(100 + 0.02, 100+0.05759306346) - (2) * 0.1
                //                 = 100.02 - (2) * 0.1
                //                 = 99.82
                freeCollateral = (await vault.getFreeCollateral(taker.address)).toString()
                expect(freeCollateral).to.be.closeTo(parseUnits("99.82", collateralDecimals), 1)
            })
        })

        describe("short first then add liquidity", async () => {
            let freeCollateralBefore: string

            beforeEach(async () => {
                // taker swap 0.013348304809274554 ETH for 2 USD
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // To fixed market twap and ignore funding payment
                await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
                await forwardBothTimestamps(clearingHouse, 1800)

                freeCollateralBefore = (await vault.getFreeCollateral(taker.address)).toString()
                // openNotional = 2
                // positionValue = (-0.013348304809274554*151) = -2.0155940262
                // unrealizedPnL = -2.0155940262 + 2 = -0.0155940262
                // free collateral = min(collateral, account value) - total debt * imRatio
                //                 = min(100, 100 + (-0.0155940262)) - (2.0155940262) * 0.1
                //                 = 99.9844059738 - (2.0155940262) * 0.1
                //                 = 99.7828465712

                // remove other maker liquidity to simplify the following tests
                const liquidity = (await orderBook.getOpenOrder(maker.address, baseToken.address, lowerTick, upperTick))
                    .liquidity
                await clearingHouse.connect(maker).removeLiquidity({
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity,
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                })
            })

            it("add liquidity below the current tick", async () => {
                await clearingHouse.connect(taker).addLiquidity({
                    baseToken: baseToken.address,
                    base: "0",
                    quote: parseEther("2"),
                    lowerTick: 49800,
                    upperTick: 50000,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                let freeCollateral = (await vault.getFreeCollateral(taker.address)).toString()

                expect(freeCollateral).to.be.eq(freeCollateralBefore)

                // swap by carol
                // swap 0.006842090768717812 ETH for 1 USD
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // {
                //     indexPrice: '151.0',
                //     markPrice: '151.358171041619064744',
                //     marketPrice: '146.88860454062238813'
                // }

                // realizedPnL = -0.000001209503724417 (is from the settlement of the funding payment during beforeEachh)
                // openNotional = quoteBalance + (quoteLiquidity + quoteFee) = ((2) + (-2)) + (1) = 1
                // positionValue = (-0.013348304809274554 + 0.006842090768717812) * 151.358171041619064744 = -0.9847686576
                // unrealizedPnL = positionValue + openNotional = -0.9847686576 + 1 = 0.0152313424
                // total debt = 0.013348304809274554 * 151.358171041619064744 = 2.0203750024
                // fee = 1 / 0.99 * 0.01 = 0.0101010101
                // free collateral = min(collateral + fee, account value) - total debt * imRatio
                // free collateral = min(100+0.0101010101-0.000001209503724417, 100+0.0101010101-0.000001209503724417+0.0152313424) - (2.0203750024) * 0.1
                //                 = 100 + 0.010101010101010101-0.000001209503724417 - (2.0203750024) * 0.1
                //                 = 99.808062
                freeCollateral = (await vault.getFreeCollateral(taker.address)).toString()
                expect(freeCollateral).to.be.eq(parseUnits("99.808063", collateralDecimals))
            })

            it("add other market liquidity below the current tick", async () => {
                await clearingHouse.connect(taker).addLiquidity({
                    baseToken: baseToken2.address,
                    base: "0",
                    quote: parseEther("2"),
                    lowerTick: 49800,
                    upperTick: 50000,
                    minBase: 0,
                    minQuote: 0,
                    useTakerBalance: false,
                    deadline: ethers.constants.MaxUint256,
                })

                let freeCollateral = (await vault.getFreeCollateral(taker.address)).toString()

                expect(freeCollateral).to.be.eq(freeCollateralBefore)

                // swap by carol
                // swap 0.006842090768717812 BTC for 1 USD
                await clearingHouse.connect(carol).openPosition({
                    baseToken: baseToken2.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("1"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // For market1:
                // {
                //     indexPrice: '151.0',
                //     markPrice: '151.358171041619064744',
                //     marketPrice: '146.88860454062238813'
                // }

                // For market2:
                // {
                //     indexPrice: '151.0',
                //     markPrice: '151.373306858723226651'
                //     marketPrice: '146.8886045406224'
                // }

                // fundingPayment = 0.000001209503724417 (from market1)
                // realizePnl = 0.0
                // openNotional = quoteBalance + (quoteLiquidity + quoteFee) = ((2) + (-2)) + (1) = 1
                // positionValue1 = (-0.013348304809274554)* 151.358171041619064744 = -2.0203750024
                // positionValue2 = 0.006842090768717812 * 151.373306858723226651 = 1.0357099055
                // unrealizedPnL = positionValue + openNotional = -2.0203750024+1.0357099055 + 1 = 0.0153349031
                // total debt = 0.013348304809274554 * 151.358171041619064744 = 2.0203750024
                // fee = 1 / 0.99 * 0.01 = 0.0101010101
                // collateral = 100 + 0.0101010101 - 0.000001209503724417 = 100.0100998006
                // free collateral = min(collateral, account value) - total debt * imRatio
                // free collateral = min(100.0100998006, 100.0100998006 + 0.0153349031) - (2.0197690111) * 0.1
                //                 = 100.0100998006 - (2.0203750024) * 0.1
                //                 = 99.808062

                freeCollateral = (await vault.getFreeCollateral(taker.address)).toString()
                expect(freeCollateral).to.be.eq(parseUnits("99.808063", collateralDecimals))
            })
        })
    })

    describe("referral code", () => {
        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
        })

        it("can be emitted", async () => {
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.utils.formatBytes32String("Hello World"),
                }),
            )
                .to.emit(clearingHouse, "ReferredPositionChanged")
                .withArgs(ethers.utils.formatBytes32String("Hello World"))
        })

        it("won't be emitted if is 0", async () => {
            await expect(
                clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    oppositeAmountBound: 0,
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                }),
            ).not.to.emit(clearingHouse, "ReferredPositionChanged")
        })
    })

    describe("baseToken and quoteToken are only transferred between uniswap pool and clearingHouse", async () => {
        let baseTokenBalanceInit, quoteTokenBalanceInit

        beforeEach(async () => {
            await deposit(taker, vault, 1000, collateral)
            baseTokenBalanceInit = await baseToken.balanceOf(clearingHouse.address)
            quoteTokenBalanceInit = await quoteToken.balanceOf(clearingHouse.address)
            expect(await baseTokenBalanceInit).to.be.not.eq(0)
            expect(await quoteTokenBalanceInit).to.be.not.eq(0)
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)
        })

        it("open long position, clearingHouse transfer quoteToken to pool and receive baseToken", async () => {
            await q2bExactInput(fixture, taker, 250, baseToken.address)
            // Should not transfer any token to clearingHouse
            const baseTokenBalance = await baseToken.balanceOf(clearingHouse.address)
            const quoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address)
            const baseBalance = await accountBalance.getBase(taker.address, baseToken.address)

            expect(quoteTokenBalanceInit.sub(quoteTokenBalance)).to.be.eq(parseEther("250"))
            expect(baseTokenBalance.sub(baseTokenBalanceInit)).to.be.eq(baseBalance)

            // Should not transfer any token to exchange
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)
        })

        it("open short position, cleaningHouse transfer baseToken to pool and receive quoteToken", async () => {
            // short  0.673541846948735088 base token with 100 quote token
            await b2qExactOutput(fixture, taker, 100, baseToken.address)
            // Should not transfer any token to clearingHouse
            const baseTokenBalance = await baseToken.balanceOf(clearingHouse.address)
            const quoteTokenBalance = await quoteToken.balanceOf(clearingHouse.address)

            // openNotional + perpFee = quoteTokenFromUniswap
            // 100 + 100*1% = 101
            expect(quoteTokenBalance.sub(quoteTokenBalanceInit)).to.be.eq(parseEther("101.010101010101010102"))
            // baseTokenToUniswap - baseTokenToUniswap * 1% (uniswapFee) = positionSize
            // baseTokenToUniswap = positionSize / 99%
            // baseTokenToUniswap = 0.673541846948735088 / 99% = 0.6803452999
            expect(baseTokenBalanceInit.sub(baseTokenBalance)).to.be.eq(parseEther("0.680345299948217261"))

            // Should not transfer any token to exchange
            expect(await baseToken.balanceOf(exchange.address)).to.be.eq(0)
            expect(await quoteToken.balanceOf(exchange.address)).to.be.eq(0)
        })
    })
})
