import { MockContract } from "@eth-optimism/smock"
import bn from "bignumber.js"
import { expect } from "chai"
import { BigNumberish, Wallet } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    InsuranceFund,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import {
    b2qExactInput,
    b2qExactOutput,
    closePosition,
    q2bExactInput,
    q2bExactOutput,
} from "../helper/clearingHouseHelper"
import { findEvent } from "../helper/events"
import { initMarket } from "../helper/marketHelper"
import { priceToTick } from "../helper/number"
import { mintAndDeposit } from "../helper/token"
import { calculateLiquidatePositionSize, getMarginRatio, syncIndexToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse takeOver (liquidate)", () => {
    const EMPTY_ADDRESS = "0x0000000000000000000000000000000000000000"
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let pool2: UniswapV3Pool
    let mockedBaseAggregator: MockContract
    let mockedBaseAggregator2: MockContract
    const oracleDecimals = 6
    const blockTimeStamp = 1

    function setPool1IndexPrice(price: BigNumberish) {
        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    function setPool2IndexPrice(price: BigNumberish) {
        mockedBaseAggregator2.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits(price.toString(), oracleDecimals), 0, 0, 0]
        })
    }

    async function _getMarginRatio(trader: Wallet) {
        const accountValue = await clearingHouse.getAccountValue(trader.address)
        const totalPositionValue = await accountBalance.getTotalAbsPositionValue(trader.address)
        const marginRatio = accountValue.lte(0) ? new bn(0) : getMarginRatio(accountValue, totalPositionValue)

        return marginRatio
    }

    async function _calculateLiquidatePositionSize(trader: Wallet, baseToken: BaseToken) {
        const positionSize = await accountBalance.getTakerPositionSize(trader.address, baseToken.address)
        const totalAbsPositionValue = await accountBalance.getTotalAbsPositionValue(trader.address)
        const absPositionValue = (await accountBalance.getTotalPositionValue(trader.address, baseToken.address)).abs()

        const marginRatio = await _getMarginRatio(trader)

        const liquidatePositionSize = marginRatio.lt(0.0625 / 2)
            ? positionSize
            : calculateLiquidatePositionSize(positionSize, totalAbsPositionValue, absPositionValue)

        return liquidatePositionSize
    }

    beforeEach(async () => {
        const uniFeeRatio = 10000 // 1%

        fixture = await loadFixture(createClearingHouseFixture(true, uniFeeRatio))
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        insuranceFund = fixture.insuranceFund
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        pool = fixture.pool
        baseToken2 = fixture.baseToken2
        pool2 = fixture.pool2
        mockedBaseAggregator = fixture.mockedBaseAggregator
        mockedBaseAggregator2 = fixture.mockedBaseAggregator2

        let initPrice = "1000"
        await initMarket(fixture, initPrice)
        await syncIndexToMarketPrice(mockedBaseAggregator, pool)

        initPrice = "10000"
        // initialize BTC pool
        await initMarket(fixture, initPrice, undefined, undefined, undefined, baseToken2.address)
        await syncIndexToMarketPrice(mockedBaseAggregator2, pool2)

        // mint collateral
        await mintAndDeposit(fixture, bob, 150)
        await mintAndDeposit(fixture, carol, 20000000)

        // carol adds liquidity
        const pool1TickSpacing = await pool.tickSpacing()
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100000"),
            quote: parseEther("10000000"),
            lowerTick: priceToTick(700, pool1TickSpacing),
            upperTick: priceToTick(1300, pool1TickSpacing),
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        const pool2TickSpacing = await pool2.tickSpacing()
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken2.address,
            base: parseEther("1000"),
            quote: parseEther("10000000"),
            lowerTick: priceToTick(9000, pool2TickSpacing),
            upperTick: priceToTick(11000, pool2TickSpacing),
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // set blockTimestamp
        await clearingHouse.setBlockTimestamp(blockTimeStamp)
    })

    it("force error, trader has no position", async () => {
        await mintAndDeposit(fixture, davis, 10000)

        // no position in baseToken
        await expect(
            clearingHouse
                .connect(davis)
                ["liquidate(address,address,int256)"](alice.address, baseToken.address, parseEther("1")),
        ).to.be.revertedWith("CH_EAV")

        // baseToken doesn't exist
        // will be failed at market status checking
        await expect(
            clearingHouse
                .connect(davis)
                ["liquidate(address,address,int256)"](alice.address, EMPTY_ADDRESS, parseEther("1")),
        ).to.be.reverted
    })

    // https://docs.google.com/spreadsheets/d/1Y1Ap58a-QfY25y-yvZ3F-J-xbOaw-mdWqYX4x0mya4c/edit#gid=332641712
    describe("single market: bob has ETH long", () => {
        beforeEach(async () => {
            // bob longs ETH
            // quote: -1000
            // base: 0.989984344318166945
            await q2bExactInput(fixture, bob, 1000, baseToken.address)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)
        })

        it("force error, market is paused", async () => {})

        it("force error, there is still order", async () => {
            // bob add liquidity
            await mintAndDeposit(fixture, bob, 10000)
            const pool1TickSpacing = await pool.tickSpacing()
            await clearingHouse.connect(bob).addLiquidity({
                baseToken: baseToken.address,
                base: parseEther("5"),
                quote: parseEther("5000"),
                lowerTick: priceToTick(500, pool1TickSpacing),
                upperTick: priceToTick(1500, pool1TickSpacing),
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("1")),
            ).to.be.revertedWith("CH_CLWTISO")
        })

        it("force error, margin ratio is above the requirement", async () => {
            await mintAndDeposit(fixture, davis, 10000)

            // index price didn't change
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("1")),
            ).to.be.revertedWith("CH_EAV")
        })

        it("force error, liquidatePositionSize is not the same direction as taker position size", async () => {
            setPool1IndexPrice(900)
            await mintAndDeposit(fixture, davis, 10000)

            // bob has long position, but we set liquidatePositionSize as short position
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("-1")),
            ).to.be.revertedWith("CH_WLD")
        })

        it("force error, liquidator's collateral is not enough", async () => {
            setPool1IndexPrice(900)

            const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
            await expect(
                clearingHouse
                    .connect(davis)
                    ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize),
            ).to.be.revertedWith("CH_NEFCI")
        })

        describe("take over too much position size", async () => {
            beforeEach(async () => {
                await mintAndDeposit(fixture, davis, 1000)
            })

            it("margin ratio between 3.125% and 6.25% -> partial liquidation", async () => {
                setPool1IndexPrice(900)

                // liquidate when
                // marginRatio 0.03125
                // liquidateRatio 0.664
                // liquidatePositionSize 0.657358017109287013
                const bobTakerPositionSizeBefore = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )

                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("100")),
                ).emit(clearingHouse, "PositionLiquidated")

                const bobTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const davisTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    davis.address,
                    baseToken.address,
                )

                expect(bobTakerPositionSizeAfter).closeTo(bobTakerPositionSizeBefore.div(2), 1)
                expect(davisTakerPositionSizeAfter).eq(bobTakerPositionSizeBefore.div(2))
            })

            it("margin ratio < 3.125% -> total liquidation", async () => {
                setPool1IndexPrice(880)

                // liquidate when
                // marginRatio 0.024
                // liquidateRatio 1
                // liquidatePositionSize 0.989984344318166945

                const bobTakerPositionSizeBefore = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )

                expect((await _getMarginRatio(bob)).lt("0.03125")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("100")),
                ).emit(clearingHouse, "PositionLiquidated")

                const bobTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const davisTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    davis.address,
                    baseToken.address,
                )

                expect(bobTakerPositionSizeAfter).eq(0)
                expect(davisTakerPositionSizeAfter).eq(bobTakerPositionSizeBefore)
            })
        })

        describe("davis liquidates bob's long position at margin ratio between 3.125% and 6.25% -> partial liquidation", () => {
            beforeEach(async () => {
                setPool1IndexPrice(900)
                await mintAndDeposit(fixture, davis, 1000)
            })

            it("davis has no position before liquidation: set liquidatePositionSize = 0", async () => {
                // bob's position size before liquidate, 989984344318166945
                // liquidate when
                // marginRatio 0.045
                // maxLiquidateRatio 0.5
                // maxliquidatePositionSize 494992172159083472

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const tx = await (
                    await clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address)
                ).wait()

                // trader's pnl:
                // -1000 (openNotional) * (0.494992172159083472 / 0.989984344318166945) (closedRatio)
                // + 445.492954943175124800 (reducedNotional) = -54.507045056824874200

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("-494992172159083472")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("445492954943175124800") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-54507045056824874200")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("494992172159083472")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-439924293006385435740") // with discountPrice (1 - 3.125%/2)
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("445492954943175124800")
                expect(positionLiquidated.args.positionSize).to.be.eq("494992172159083472")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("11137323873579378120") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-11137323873579378120")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("5568661936789689060")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq(
                    "494992172159083473", // 0.989984344318166945 - 0.494992172159083472
                )
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq(
                    "-500000000000000001000", // -(1000 * (1 - 0.494992172159083473 / 0.989984344318166945))
                )

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "494992172159083472",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-439924293006385435740",
                )

                // margin ratio after take over: 8.74%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gt("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address),
                ).to.be.revertedWith("CH_EAV")
            })

            it("davis has no position before liquidation", async () => {
                // bob's position size before liquidate, 989984344318166945
                // liquidate when
                // marginRatio 0.045
                // maxLiquidateRatio 0.5
                // maxliquidatePositionSize 494992172159083472

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // -1000 (openNotional) * (0.494992172159083472 / 0.989984344318166945) (closedRatio)
                // + 445.492954943175124800 (reducedNotional) = -54.507045056824874200

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("-494992172159083472")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("445492954943175124800") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-54507045056824874200")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("494992172159083472")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-439924293006385435740") // with discountPrice (1 - 3.125%/2)
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("445492954943175124800")
                expect(positionLiquidated.args.positionSize).to.be.eq("494992172159083472")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("11137323873579378120") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-11137323873579378120")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("5568661936789689060")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq(
                    "494992172159083473", // 0.989984344318166945 - 0.494992172159083472
                )
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq(
                    "-500000000000000001000", // -(1000 * (1 - 0.494992172159083473 / 0.989984344318166945))
                )

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "494992172159083472",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-439924293006385435740",
                )

                // margin ratio after take over: 8.74%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gt("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })

            it("davis has long position and liquidates bob's long position, no pnl realized", async () => {
                // davis long ETH before liquidate bob's ETH long position
                // quote: -1010.149094153067713775
                // base: 1
                await q2bExactOutput(fixture, davis, 1, baseToken.address)

                // liquidate when
                // marginRatio 0.045
                // liquidateRatio 0.5
                // liquidatePositionSize 0.494992172159083472

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "1494992172159083472",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-1450073387159453149515", // 439924293006385435740
                )

                // margin ratio after take over: 8.74%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gt("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })

            it("davis has short position and liquidates bob's long position, has realized pnl", async () => {
                // davis short ETH before liquidate bob's ETH long position
                // quote: 990.015497538652489601
                // base: -1
                await b2qExactInput(fixture, davis, 1, baseToken.address)

                // liquidate when
                // marginRatio 0.045
                // liquidateRatio 0.5
                // liquidatePositionSize 0.494992172159083472

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // liquidator has -1 short position and takes over +0.657358017109287013 long position,
                // so liquidator reduces his short position, and realizes pnl
                // liquidator's pnl:
                // 990.015497538652489601 (openNotional) * (0.494992172159083472 / 1) (closedRatio) - 439.924293006385435740 (reducedNotional) = 50.1256285914
                // new openNotional:
                // 990.01549753865 - 439.924293006385435740 - 50.1256285914 = 499.965575941

                // verify events
                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("494992172159083472")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-439924293006385435740") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("50125628591427916723")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "-505007827840916528", // -1 + 0.494992172159083472, 0.50500782784
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "499965575940839137138",
                )

                // margin ratio after take over: 8.74%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gt("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })
        })

        describe("davis liquidates bob's long position at margin ratio < 3.125% -> total liquidation", () => {
            beforeEach(async () => {
                setPool1IndexPrice(880)

                // deposit enough collateral for liquidator
                await mintAndDeposit(fixture, davis, 1000)
            })

            it("davis has no position before liquidation", async () => {
                // liquidate when
                // marginRatio 0.024
                // liquidateRatio 1
                // liquidatePositionSize 0.989984344318166945

                // less than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // -1000 (openNotional) * (0.989984 / 0.989984) (closedRatio) + 871.186223 (reducedNotional) = -128.813777

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("-989984344318166945")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("871186222999986911600") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-128813777000013088400")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("989984344318166945")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-860296395212487075205") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("871186222999986911600")
                expect(positionLiquidated.args.positionSize).to.be.eq("989984344318166945")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("21779655574999672790") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-21779655574999672790")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("10889827787499836395")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq("0")
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq("0")

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "989984344318166945",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-860296395212487075205",
                )

                // cannot liquidate since bob has no position
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_PSZ")
            })

            it("davis has long position and liquidates bob's long position, no pnl realized", async () => {
                // davis long ETH before liquidate bob's ETH long position
                // quote: -1010.149094153067713775
                // base: 1
                await q2bExactOutput(fixture, davis, 1, baseToken.address)

                // liquidate when
                // marginRatio 0.024
                // liquidateRatio 100%
                // liquidatePositionSize 0.989984344318166945

                // less than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                // verify position size
                // 1 + 0.989984344318166945 = 1.989984344318166945
                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "1989984344318166945",
                )
                // -1010.14909 + (-0.98998434431816 * 880 *.9875) = -1870.44548
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-1870445489365554788980",
                )

                // bob still has owedRealizePnl which makes account value is not 0
                expect(await clearingHouse.getAccountValue(bob.address)).not.eq("0")
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
            })

            it("davis has short position and liquidates bob's long position, has realized pnl", async () => {
                // davis short ETH before liquidate bob's ETH long position
                // quote: 990.015497538652489601
                // base: -1
                await b2qExactInput(fixture, davis, 1, baseToken.address)

                // liquidate when
                // marginRatio 0.024
                // liquidateRatio 100%
                // liquidatePositionSize 0.989984344318166945

                // less than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // liquidator has -1 short position and takes over +0.989984344318166945 long position,
                // so liquidator reduces his short position, and realizes pnl
                // liquidator's pnl:
                // 990.015497 (openNotional) * (0.98998434 / 1) (closedRatio) - 860.29639521 (reducedNotional) = 108.913638
                // new openNotional:
                // 990.01549753865 - 871.1862 - 108.913638 = 9.9156595

                // verify events
                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("989984344318166945")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-860296395212487075205") // 871.1862*.9875
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("119803447983139630711")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "-10015655681833055", // -1 + 0.989984344318166945
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "9915654343025783685",
                )

                // bob still has owedRealizePnl which makes account value is not 0
                expect(await clearingHouse.getAccountValue(bob.address)).not.eq("0")
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
            })
        })

        describe("davis liquidates bob's long position with bad debt", () => {
            it("liquidator gets 100% liquidation penalty", async () => {
                setPool1IndexPrice(100)

                // deposit enough collateral for liquidator
                await mintAndDeposit(fixture, davis, 1000)

                // liquidate when
                // marginRatio 0
                // liquidateRatio 1
                // liquidatePositionSize 0.989984344318166945

                expect((await _getMarginRatio(bob)).eq(0)).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // verify events
                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("98998434431816694500")
                expect(positionLiquidated.args.positionSize).to.be.eq("989984344318166945")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("2474960860795417362") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-2474960860795417362")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq("0")
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq("0")
                expect((await _getMarginRatio(bob)).eq(0)).to.be.true
            })
        })

        it("close davis's position after bob got liquidated")
    })

    describe("single market: bob has ETH short", () => {
        beforeEach(async () => {
            // bob shorts ETH
            // quote: 1000
            // base: -1.010117308505193671
            await b2qExactOutput(fixture, bob, 1000, baseToken.address)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)
        })

        describe("take over too much position size", async () => {
            beforeEach(async () => {
                await mintAndDeposit(fixture, davis, 1000)
            })

            it("margin ratio between 3.125% and 6.25% -> partial liquidation", async () => {
                setPool1IndexPrice(1090)

                // liquidate when
                // marginRatio 0.044
                // liquidateRatio 0.5
                // liquidatePositionSize -0.50505865425
                const bobTakerPositionSizeBefore = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )

                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("-100")),
                ).emit(clearingHouse, "PositionLiquidated")

                const bobTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const davisTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    davis.address,
                    baseToken.address,
                )

                expect(bobTakerPositionSizeAfter).closeTo(bobTakerPositionSizeBefore.div(2), 1)
                expect(davisTakerPositionSizeAfter).eq(bobTakerPositionSizeBefore.div(2))
            })

            it("margin ratio < 3.125% -> total liquidation", async () => {
                setPool1IndexPrice(1120)

                // liquidate when
                // marginRatio 0.044
                // liquidateRatio 0.5
                // liquidatePositionSize -0.50505865425

                const bobTakerPositionSizeBefore = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )

                expect((await _getMarginRatio(bob)).lt("0.03125")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("-100")),
                ).emit(clearingHouse, "PositionLiquidated")

                const bobTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    bob.address,
                    baseToken.address,
                )
                const davisTakerPositionSizeAfter = await accountBalance.getTakerPositionSize(
                    davis.address,
                    baseToken.address,
                )

                expect(bobTakerPositionSizeAfter).eq(0)
                expect(davisTakerPositionSizeAfter).eq(bobTakerPositionSizeBefore)
            })
        })

        describe("davis liquidates bob's short position at margin ratio between 3.125% and 6.25% -> partial liquidation", () => {
            beforeEach(async () => {
                setPool1IndexPrice(1090)
                await mintAndDeposit(fixture, davis, 1000)
            })
            it("davis has no position before liquidation", async () => {
                // liquidate when
                // marginRatio 0.044
                // liquidateRatio 0.5
                // liquidatePositionSize -0.50505865425

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // 1000 (openNotional) * (-0.50505865425 / -1.010117) (closedRatio) + -550.51393313 (reducedNotional) = -50.51378042

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("505058654252596835")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("-550513933135330550150") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-50513933135330551150")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("-505058654252596835")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("557395357299522182026") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("550513933135330550150")
                expect(positionLiquidated.args.positionSize).to.be.eq("505058654252596835")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("13762848328383263753") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-13762848328383263753")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("6881424164191631877")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq(
                    "-505058654252596836", // -1.010117308505193671 + 0.505058654252596835
                )
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq(
                    "500000000000000001000", // 1000 + (-550.513933135330550150) - (-50.513933135330551150)
                )

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "-505058654252596835",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "557395357299522182026",
                )

                // margin ratio after take over: 8.74%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gte("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })

            it("davis has short position and liquidates bob's short position, no pnl realized", async () => {
                // davis short ETH before liquidate bob's ETH short position
                // quote: 989.952239589299159557
                // base: -1
                await b2qExactInput(fixture, davis, 1, baseToken.address)

                // liquidate when
                // marginRatio 0.044
                // liquidateRatio 0.5
                // liquidatePositionSize -0.50505865425

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.0312")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // 1000 (openNotional) * (-0.50505865425 / -1.010117) (closedRatio) + -550.51393313 (reducedNotional) = -50.51378042

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("557395357299522182026") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "-1505058654252596835", // -1 + (-0.505058654252596835)
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "1547347596888821341583", // 989.952239589299159557 + 557.395357299522182026
                )

                // margin ratio after take over: 8.74%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gte("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })

            it("davis has long position and liquidates bob's short position, has realized pnl", async () => {
                // davis long ETH before liquidate bob's ETH short position
                // quote: -1010.084548718074825888
                // base: 1
                await q2bExactOutput(fixture, davis, 1, baseToken.address)

                // liquidate when
                // marginRatio 0.044
                // liquidateRatio 0.5
                // liquidatePositionSize -0.50505865425

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // liquidator has 1 long position and takes over -0.505058654252596835 short position,
                // so liquidator reduces his short position, and realizes pnl
                // liquidator's pnl:
                // -1010.084548718 (openNotional) * (0.505058654252596835 / 1) (closedRatio) + 557.395357299522182026 (reducedNotional) = 47.2434144427
                // new openNotional:
                // -1010.084548718 + (557.395357299522182026) - (47.2434144427) = -499.9326058612

                // verify events
                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("-505058654252596835")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("557395357299522182026") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("47243414442629724904") // 47243414442629724904

                // verify position size
                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "494941345747403165", // 1 + (-0.505058654252596835)
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-499932605861182368766",
                )

                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gte("0.0625")).to.be.true
                expect(await vault.getFreeCollateral(davis.address)).to.be.gt("0")
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })
        })

        describe("davis liquidates bob's short position at margin ratio < 3.125% -> total liquidation", () => {
            beforeEach(async () => {
                setPool1IndexPrice(1120)
                await mintAndDeposit(fixture, davis, 1000)
            })
            it("davis has no position before liquidation", async () => {
                // liquidate when
                // marginRatio 0.016
                // liquidateRatio 1
                // liquidatePositionSize -1.010117308505193671

                // less than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // 1000 (openNotional) * (-1.010117 / -1.010117) (closedRatio) + -1131.331385 (reducedNotional) = -131.331385

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("1010117308505193671")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("-1131331385525816911520") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-131331385525816911520")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("-1010117308505193671")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("1145473027844889622914") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("1131331385525816911520")
                expect(positionLiquidated.args.positionSize).to.be.eq("1010117308505193671")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("28283284638145422788") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-28283284638145422788")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("14141642319072711394")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq("0")
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq("0")

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "-1010117308505193671",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "1145473027844889622914",
                )

                // cannot liquidate since bob has no position
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_PSZ")
            })
        })
    })

    // https://docs.google.com/spreadsheets/d/1Y1Ap58a-QfY25y-yvZ3F-J-xbOaw-mdWqYX4x0mya4c/edit#gid=332641712
    describe("multiple markets: bob has ETH long and BTC short", () => {
        beforeEach(async () => {
            await mintAndDeposit(fixture, davis, 1000)

            // bob longs ETH at index price = 1,000
            // quote: -1000
            // base: 0.989984344318166945
            await q2bExactInput(fixture, bob, 1000, baseToken.address)

            // bob shorts BTC at index price = 10,000
            // quote: 100
            // base: -0.010101015599550667
            await b2qExactOutput(fixture, bob, 100, baseToken2.address)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)
        })

        describe("davis liquidates bob at margin ratio between 3.125% and 6.25% -> partial liquidation", () => {
            beforeEach(async () => {
                setPool1IndexPrice(910) // ETH (has loss)
                setPool2IndexPrice(9900) // BTC (has profit)
            })

            it("davis has no position before liquidating bob's long position on ETH market", async () => {
                // liquidate when
                // marginRatio 0.0508
                // totalPositionValue =  0.989984344318166945 * 910 + 0.010101015599550667*9900 = 1000.8858077651
                // ethPositionValue = 900.8857533295
                // liquidateRatio 0.5555
                // liquidatePositionSize 0.5499363033

                // greater than 3.125%
                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // -1000 (openNotional) * 0.5555 (closedRatio) + 500.4420359746(reducedNotional) = -55.0579640254

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("-549936303268741737")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("500442035974554980670") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-55057964025445018330")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("549936303268741737")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-494186510524873043412") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("500442035974554980670")
                expect(positionLiquidated.args.positionSize).to.be.eq("549936303268741737")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("12511050899363874516") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-12511050899363874516")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("6255525449681937258")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq(
                    "440048041049425208", // 0.989984344318166945 - 0.549936303268741737
                )
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq(
                    "-444500000000000001000", // -1000 + 500.442035974554980670 - (-55.057964025445018330)
                )

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "549936303268741737",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-494186510524873043412",
                )

                // margin ratio after take over: 7.67%
                // margin ratio is > 6.25%, cannot liquidate anymore
                expect((await _getMarginRatio(bob)).gte("0.0625")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, 1),
                ).to.be.revertedWith("CH_EAV")
            })

            it("davis has no position before liquidating bob's short position on BTC market", async () => {
                // liquidate when
                // marginRatio 0.0508
                // totalPositionValue =  0.989984344318166945 * 910 + 0.010101015599550667*9900 = 1000.8858077651
                // btcPositionValue = 100.0000544356
                // liquidateRatio 1
                // liquidatePositionSize 0.010101015599550667

                expect((await _getMarginRatio(bob)).gte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken2)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken2.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // 100 (openNotional) * 1 (closedRatio) - 100.0000544356 (reducedNotional) = -0.0000544356

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken2.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("10101015599550667")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("-100000054435551603300") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-54435551603300")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken2.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("-10101015599550667")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("101250055115995998341") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken2.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("100000054435551603300")
                expect(positionLiquidated.args.positionSize).to.be.eq("10101015599550667")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("2500001360888790082") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-2500001360888790082")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("1250000680444395041")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken2.address)).to.be.eq("0")
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken2.address)).to.be.eq("0")

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken2.address)).to.be.eq(
                    "-10101015599550667",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken2.address)).to.be.eq(
                    "101250055115995998341",
                )

                _getMarginRatio(bob)
                // margin ratio after take over: 4.26%
                // margin ratio is < 6.25%, can still liquidate ETH
                expect((await _getMarginRatio(bob)).lte("0.0625")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("0.1")),
                ).to.emit(clearingHouse, "PositionLiquidated")
            })
        })

        describe("davis liquidates bob's long position at margin ratio < 3.125% -> total liquidation", () => {
            beforeEach(async () => {
                setPool1IndexPrice(880) // ETH (has loss)
                setPool2IndexPrice(9900) // BTC (has profit)
            })

            it("davis has no position before liquidating bob's long position on ETH market", async () => {
                // liquidate when
                // marginRatio 0.0218
                // liquidateRatio 100%
                // liquidatePositionSize 0.989984344318166945

                // less than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // -1000 (openNotional) * 1 (closedRatio) + 871.186222 (reducedNotional) = -128.813778

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("-989984344318166945")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("871186222999986911600") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-128813777000013088400")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("989984344318166945")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("-860296395212487075205") // exchangedPositionSize * .9875
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("871186222999986911600")
                expect(positionLiquidated.args.positionSize).to.be.eq("989984344318166945")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("21779655574999672790") // trader's exchangedPositionNotional * 2.5%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-21779655574999672790")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("10889827787499836395")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq("0")
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq("0")

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken.address)).to.be.eq(
                    "989984344318166945",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken.address)).to.be.eq(
                    "-860296395212487075205",
                )

                // margin ratio will be lower than the margin ratio before taking over if it's lower than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken2.address, parseEther("-0.01")),
                ).to.emit(clearingHouse, "PositionLiquidated")
            })

            it("davis has no position before liquidating bob's short position on BTC market", async () => {
                // liquidate when
                // marginRatio 0.0218
                // liquidateRatio 100%
                // liquidatePositionSize -0.010101015599550667

                // less than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                const liquidatePositionSize = await _calculateLiquidatePositionSize(bob, baseToken2)
                const tx = await (
                    await clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken2.address, liquidatePositionSize)
                ).wait()

                // trader's pnl:
                // 100 (openNotional) * 1 (closedRatio) + -100.0000544356 (reducedNotional) = -0.0000544356

                // verify events
                const traderPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 0)
                expect(traderPositionChanged.args.trader).to.be.eq(bob.address)
                expect(traderPositionChanged.args.baseToken).to.be.eq(baseToken2.address)
                expect(traderPositionChanged.args.exchangedPositionSize).to.be.eq("10101015599550667")
                expect(traderPositionChanged.args.exchangedPositionNotional).to.be.eq("-100000054435551603300") // exchangedPositionSize * indexPrice
                expect(traderPositionChanged.args.realizedPnl).to.be.eq("-54435551603300")

                const liquidatorPositionChanged = findEvent(tx, clearingHouse, "PositionChanged", 1)
                expect(liquidatorPositionChanged.args.trader).to.be.eq(davis.address)
                expect(liquidatorPositionChanged.args.baseToken).to.be.eq(baseToken2.address)
                expect(liquidatorPositionChanged.args.exchangedPositionSize).to.be.eq("-10101015599550667")
                expect(liquidatorPositionChanged.args.exchangedPositionNotional).to.be.eq("101250055115995998341") // with discountPrice
                expect(liquidatorPositionChanged.args.realizedPnl).to.be.eq("0")

                const positionLiquidated = findEvent(tx, clearingHouse, "PositionLiquidated")
                expect(positionLiquidated.args.trader).to.be.eq(bob.address)
                expect(positionLiquidated.args.baseToken).to.be.eq(baseToken2.address)
                expect(positionLiquidated.args.positionNotional).to.be.eq("100000054435551603300")
                expect(positionLiquidated.args.positionSize).to.be.eq("10101015599550667")
                expect(positionLiquidated.args.liquidationFee).to.be.eq("2500001360888790082") // trader's exchangedPositionNotional * 2.5% * 50%

                // to pay liquidation penalty
                const pnlRealizedTrader = findEvent(tx, accountBalance, "PnlRealized", 2)
                expect(pnlRealizedTrader.args.trader).to.be.eq(bob.address)
                expect(pnlRealizedTrader.args.amount).to.be.eq("-2500001360888790082")

                // liquidation fee to insurance fund
                const pnlRealizedIf = findEvent(tx, accountBalance, "PnlRealized", 3)
                expect(pnlRealizedIf.args.trader).to.be.eq(insuranceFund.address)
                expect(pnlRealizedIf.args.amount).to.be.eq("1250000680444395041")

                // verify position size
                expect(await accountBalance.getTakerPositionSize(bob.address, baseToken2.address)).to.be.eq("0")
                expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken2.address)).to.be.eq("0")

                expect(await accountBalance.getTakerPositionSize(davis.address, baseToken2.address)).to.be.eq(
                    "-10101015599550667",
                )
                expect(await accountBalance.getTakerOpenNotional(davis.address, baseToken2.address)).to.be.eq(
                    "101250055115995998341",
                )

                // margin ratio will be lower than the margin ratio before taking over if it's lower than 3.125%
                expect((await _getMarginRatio(bob)).lte("0.03125")).to.be.true
                await expect(
                    clearingHouse
                        .connect(davis)
                        ["liquidate(address,address,int256)"](bob.address, baseToken.address, parseEther("0.1")),
                ).to.emit(clearingHouse, "PositionLiquidated")
            })
        })
    })

    // https://www.notion.so/perp/Backstop-LP-Spec-614b42798d4943768c2837bfe659524d#1fb6fd089d284a09b82bd1a8be709cd7
    describe("multiple markets: intentional bad debt by price manipulation on the other market", () => {
        // step1, bob long ETH and long BTC at the same time

        // step2, carol short BTC to manipulate BTC price in order to make bob being liquidated

        // step3, bob close BTC position to realized loss
        beforeEach(async () => {
            // bob longs ETH at index price = 1,000
            // quote: -100
            // base: 0.098999843440953452
            const quoteAmount = 100
            await q2bExactInput(fixture, bob, quoteAmount, baseToken.address)

            // bob long BTC at index price = 10,000
            // quote: -1250
            // base: 0.123749174712808148
            // margin ratio = 0.1021267859313063266729576261160639035403
            const quote2Amount = 1250
            await q2bExactInput(fixture, bob, quote2Amount, baseToken2.address)

            // Wait for ETH has loss, but not liquidated yet.
            // margin ratio = 0.0675930318386502438218536063133746101549
            await setPool1IndexPrice(500)

            // increase blockTimestamp
            await clearingHouse.setBlockTimestamp(blockTimeStamp + 1)
        })

        it("force error, bob didn't have enough margin after closing position", async () => {
            await mintAndDeposit(fixture, alice, 2_000_000)
            // alice short BTC position
            await b2qExactOutput(fixture, alice, 6_000_000, baseToken2.address)

            // bob can not close btc position due to enough remaining margin
            await expect(closePosition(fixture, bob, 0, baseToken2.address)).to.be.revertedWith("CH_NEMRM")
        })

        it("bob has enough margin to pay liquidation penalty for the rest positions which might be liquidated after closing/reducing position", async () => {
            await mintAndDeposit(fixture, alice, 2_000_000)
            // alice short BTC position
            await b2qExactOutput(fixture, alice, 5_585_000, baseToken2.address)

            // bob closed his BTC position
            // margin ratio: 0.031255530020907139166385999350904942563886
            await closePosition(fixture, bob, 0, baseToken2.address)

            // davis liquidates bob's ETH position but can not liquidate all position
            await mintAndDeposit(fixture, davis, 10000)
            await clearingHouse.connect(davis)["liquidate(address,address)"](bob.address, baseToken.address)

            // should be liquidated 100% of eth position
            expect(await accountBalance.getTakerPositionSize(bob.address, baseToken.address)).to.be.eq("0")
            expect(await accountBalance.getTakerOpenNotional(bob.address, baseToken.address)).to.be.eq("0")

            expect(await clearingHouse.getAccountValue(bob.address)).to.be.gte("0")
        })
    })
})
