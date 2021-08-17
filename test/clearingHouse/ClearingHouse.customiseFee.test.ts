import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { ClearingHouse, TestERC20, UniswapV3Pool, Vault, VirtualToken } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe.skip("ClearingHouse customized fee", () => {
    const [admin, maker, taker, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let vault: Vault
    let collateral: TestERC20
    let baseToken: VirtualToken
    let quoteToken: VirtualToken
    let pool: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let collateralDecimals: number
    const lowerTick: number = 0
    const upperTick: number = 100000

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        mockedBaseAggregator = _clearingHouseFixture.mockedBaseAggregator
        pool = _clearingHouseFixture.pool
        collateralDecimals = await collateral.decimals()

        // set fee ratio to 2%
        await clearingHouse.setFeeRatio(baseToken.address, 20000)

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("100", 6), 0, 0, 0]
        })

        await pool.initialize(encodePriceSqrt("151.373306858723226652", "1")) // tick = 50200 (1.0001^50200 = 151.373306858723226652)
        // add pool after it's initialized
        await clearingHouse.addPool(baseToken.address, 10000)

        // prepare collateral for maker
        const makerCollateralAmount = parseUnits("1000000", collateralDecimals)
        await collateral.mint(maker.address, makerCollateralAmount)
        await deposit(maker, vault, 1000000, collateral)

        // maker add liquidity
        await clearingHouse.connect(maker).mint(baseToken.address, parseEther("65.943787")) // should only mint exact amount
        await clearingHouse.connect(maker).mint(quoteToken.address, parseEther("10000"))
        await clearingHouse.connect(maker).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("65.943787"),
            quote: parseEther("10000"),
            lowerTick,
            upperTick,
            minBase: 0,
            minQuote: 0,
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
    describe("CH fee ratio > uniswap pool fee ratio", async () => {
        describe("taker open position from zero", async () => {
            beforeEach(async () => {
                await deposit(taker, vault, 1000, collateral)

                // expect all available and debt are zero
                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(0)).to.be.true
                expect(baseInfo.debt.eq(0)).to.be.true
                expect(quoteInfo.available.eq(0)).to.be.true
                expect(quoteInfo.debt.eq(0)).to.be.true
            })

            it("long and exact in", async () => {
                const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                // taker swap 1 USD for ? ETH
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Swapped")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        "6539527905092835", // exchangedPositionSize
                        parseEther("-0.99"), // costBasis
                        parseEther("0.01"), // fee = 1 * 0.01
                        parseEther("0"), // fundingPayment
                        parseEther("0"), // badDebt
                    )

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.gt(parseEther("0"))).to.be.true
                expect(baseInfo.debt).be.deep.eq(parseEther("0"))
                expect(quoteInfo.available).be.deep.eq(parseEther("0"))
                expect(quoteInfo.debt).be.deep.eq(parseEther("1"))

                expect(await quoteToken.balanceOf(clearingHouse.address)).be.eq(balanceBefore.add(parseEther("0.01")))
            })

            it("long and exact out", async () => {
                // taker swap ? USD for 1 ETH -> quote to base -> fee is charged before swapping
                //   exchanged notional = 71.9062751863 * 10884.6906588362 / (71.9062751863 - 1) - 10884.6906588362 = 153.508143394
                //   taker fee = 153.508143394 / 0.99 * 0.01 = 1.550587307
                const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: false,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Swapped")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("1"), // exchangedPositionSize
                        "-153508143394151325059", // costBasis
                        "1550587307011629547", // fee
                        parseEther("0"), // fundingPayment
                        parseEther("0"), // badDebt
                    )

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available).be.deep.eq(parseEther("1"))
                expect(baseInfo.debt).be.deep.eq(parseEther("0"))
                expect(quoteInfo.available).be.deep.eq(parseEther("0"))
                expect(quoteInfo.debt.gt(parseEther("0"))).to.be.true

                expect(await quoteToken.balanceOf(clearingHouse.address)).be.eq(
                    balanceBefore.add(parseEther("1.550587307011629547")),
                )
            })

            it("short and exact in", async () => {
                // taker swap ? USD for 1 ETH -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
                //   taker fee = 149.2970341856 * 0.01 = 1.492970341856

                const balanceBefore = await baseToken.balanceOf(clearingHouse.address)

                // taker swap 1 ETH for ? USD
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Swapped")
                    .withArgs(
                        taker.address, // trader
                        baseToken.address, // baseToken
                        parseEther("-1"), // exchangedPositionSize
                        parseEther("149.297034185732877727"), // costBasis
                        parseEther("1.492970341857328778"), // fee: 149.297034185732877727 * 0.01 = 1.492970341857328777
                        parseEther("0"), // fundingPayment
                        parseEther("0"), // badDebt
                    )

                const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                expect(baseInfo.available.eq(parseEther("0"))).to.be.true
                expect(baseInfo.debt.eq(parseEther("1"))).to.be.true
                expect(quoteInfo.available.gt(parseEther("0"))).to.be.true
                expect(quoteInfo.debt.eq(parseEther("0"))).to.be.true

                expect(await baseToken.balanceOf(clearingHouse.address)).to.be.eq(balanceBefore)
            })

            it("short and exact out", async () => {
                // taker swap ? USD for 1 ETH -> base to quote -> fee is included in exchangedNotional
                //   taker exchangedNotional = 10884.6906588362 - 71.9062751863 * 10884.6906588362 / (71.9062751863 + 1) = 149.2970341856
                //   taker fee = 149.2970341856 * 0.01 = 1.492970341856
                // const balanceBefore = await baseToken.balanceOf(clearingHouse.address)
                // // taker swap 1 ETH for ? USD
                // await expect(
                //     clearingHouse.connect(taker).openPosition({
                //         baseToken: baseToken.address,
                //         isBaseToQuote: true,
                //         isExactInput: true,
                //         amount: parseEther("1"),
                //         sqrtPriceLimitX96: 0,
                //     }),
                // )
                //     .to.emit(clearingHouse, "Swapped")
                //     .withArgs(
                //         taker.address, // trader
                //         baseToken.address, // baseToken
                //         parseEther("-1"), // exchangedPositionSize
                //         parseEther("149.297034185732877727"), // costBasis
                //         parseEther("1.492970341857328778"), // fee: 149.297034185732877727 * 0.01 = 1.492970341857328777
                //         parseEther("0"), // fundingPayment
                //         parseEther("0"), // badDebt
                //     )
                // const baseInfo = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                // const quoteInfo = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                // expect(baseInfo.available.eq(parseEther("0"))).to.be.true
                // expect(baseInfo.debt.eq(parseEther("1"))).to.be.true
                // expect(quoteInfo.available.gt(parseEther("0"))).to.be.true
                // expect(quoteInfo.debt.eq(parseEther("0"))).to.be.true
                // expect(await baseToken.balanceOf(clearingHouse.address)).to.be.eq(balanceBefore)
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
                    amount: parseEther("2"),
                    sqrtPriceLimitX96: 0,
                })
                // virtual base liquidity = 71.9062751863 - 0.01307786649 = 71.8931973198
                // virtual quote liquidity = 10884.6906588362 + 2 * 0.99 = 10886.6706588362
            })

            it("increase position and exact in", async () => {
                const balanceBefore = await quoteToken.balanceOf(clearingHouse.address)

                const baseInfoBefore = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfoBefore = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)

                // taker swap 1 USD for ? ETH again
                await expect(
                    clearingHouse.connect(taker).openPosition({
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        amount: parseEther("1"),
                        sqrtPriceLimitX96: 0,
                    }),
                )
                    .to.emit(clearingHouse, "Minted")
                    .withArgs(taker.address, quoteToken.address, parseEther("1"))

                // increase ? USD debt, increase 1 ETH available, the rest remains the same
                const baseInfoAfter = await clearingHouse.getTokenInfo(taker.address, baseToken.address)
                const quoteInfoAfter = await clearingHouse.getTokenInfo(taker.address, quoteToken.address)
                const increasedQuoteDebt = quoteInfoAfter.debt.sub(quoteInfoBefore.debt)
                const increasedBaseAvailable = baseInfoAfter.available.sub(baseInfoBefore.available)
                expect(increasedQuoteDebt).deep.eq(parseEther("1"))
                expect(increasedBaseAvailable.gt(parseEther("0"))).to.be.true
                expect(baseInfoAfter.debt.sub(baseInfoBefore.debt)).deep.eq(parseEther("0"))
                expect(quoteInfoAfter.available.sub(quoteInfoBefore.available)).deep.eq(parseEther("0"))

                // pos size: 0.01961501593
                expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq("19615015933642630")
                expect(await clearingHouse.getNetQuoteBalance(taker.address)).to.eq(parseEther("-3"))

                expect(await quoteToken.balanceOf(clearingHouse.address)).to.eq(balanceBefore.add(parseEther("0.01")))
            })

            it("increase position and exact out", async () => {})

            it("open larger reverse position and exact in", async () => {
                // taker has 2 USD worth ETH long position
                // then opens 10 USD worth ETH short position
                await clearingHouse.connect(taker).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: false,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                })

                // position size = -0.05368894844
                expect(await clearingHouse.getPositionSize(taker.address, baseToken.address)).to.eq(
                    "-53688948443543907",
                )

                // openNotional = 8.0412624948
                expect(await clearingHouse.getOpenNotional(taker.address, baseToken.address)).to.eq(
                    "8041262494847024252",
                )

                // realizedPnl = -0.04126249485
                expect(await clearingHouse.getOwedRealizedPnl(taker.address)).to.eq("-41262494847024252")
            })

            it("open larger reverse position and exact out", async () => {})
        })
    })
})
