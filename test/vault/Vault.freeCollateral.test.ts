import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    MarketRegistry,
    TestAccountBalance,
    TestClearingHouse,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forwardBothTimestamps, initiateBothTimestamps } from "../shared/time"
import { mockIndexPrice, mockMarkPrice } from "../shared/utilities"

describe("Vault getFreeCollateral", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let mockedWethPriceFeed: MockContract
    let mockedWbtcPriceFeed: MockContract
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedPriceFeedDispatcher: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        vault = fixture.vault
        usdc = fixture.USDC
        weth = fixture.WETH
        wbtc = fixture.WBTC
        mockedWethPriceFeed = fixture.mockedWethPriceFeed
        mockedWbtcPriceFeed = fixture.mockedWbtcPriceFeed
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        pool = fixture.pool
        baseToken = fixture.baseToken
        marketRegistry = fixture.marketRegistry
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        fixture = fixture

        usdcDecimals = await usdc.decimals()

        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice, undefined, 0)
        await mockIndexPrice(mockedPriceFeedDispatcher, "151")

        // mint and add liquidity
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        mockedWethPriceFeed.smocked.getPrice.will.return.with(parseUnits("3000", 8))
        mockedWbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("40000", 8))

        await weth.mint(alice.address, parseEther("10"))
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.mint(alice.address, parseUnits("5", await wbtc.decimals()))
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

        await usdc.mint(bob.address, parseUnits("1000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)

        await clearingHouse.connect(bob).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("200"),
            quote: parseEther("100000"),
            lowerTick: 0,
            upperTick: 150000,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    describe("# getFreeCollateral", () => {
        describe("freeCollateral should include funding payment", () => {
            beforeEach(async () => {
                const amount = parseUnits("100", usdcDecimals)
                await vault.connect(alice).deposit(usdc.address, amount)
            })

            it("long then get free collateral", async () => {
                // set index price for a positive funding
                await mockIndexPrice(mockedPriceFeedDispatcher, "150")

                // alice long 0.065379992856491801 ETH for 10 USD
                await clearingHouse.connect(alice).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("10"),
                    sqrtPriceLimitX96: 0,
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // mock mark price for fixed position value
                await mockMarkPrice(accountBalance, baseToken.address, "150")

                // openNotional = -10
                // positionValue = 0.065379992856491801 * 150 = 9.8069989285
                // unrealizedPnL = 9.8069989285 -10 = -0.1930010715
                // freeCollateral = min(collateral, accountValue) - totalDebt * imRatio
                //                = min(100, 100-0.1930010715) - 10*0.1
                //                = 98.806998

                await forwardBothTimestamps(clearingHouse, 3600)

                // alice should pay funding payment
                // note that bob will settle his pending funding payment here

                // fundingPayment = positionSize * pricePremium * 3600 / (24 * 3600)
                //                = 0.065379992856491801 * (151.4641535519 - 150) * 3600 / (24 * 3600)
                //                = 0.00398859786
                // freeCollateral = 98.806998 - 0.00398859786
                //                = 98.803009

                const freeCollateral = (await vault.getFreeCollateral(alice.address)).toString()
                expect(freeCollateral).to.be.closeTo(parseUnits("98.803009", usdcDecimals), 20)
            })
        })

        describe("freeCollateral should include pending maker fee", () => {
            beforeEach(async () => {
                const amount = parseUnits("1000", usdcDecimals)
                await vault.connect(alice).deposit(usdc.address, amount)
            })

            it("maker make profit", async () => {
                // alice swap to pay fee
                await marketRegistry.setFeeRatio(baseToken.address, 0.5e6)
                await q2bExactInput(fixture, alice, 100)

                // mock mark price for fixed debt value and position value
                await mockMarkPrice(accountBalance, baseToken.address, "80")

                // bob debt value: 16000 (baseDebt) + 28004.62178853 (quoteDebt) = 44004.62178853
                // as bob has a profit, using totalCollateralValue for free collateral
                // free collateral: balance + owedRealizedPnl + pendingFee + pendingFunding (= totalCollateralValue) - totalMarginRequirement
                // 1000000 + 0 + 100 * 0.5 (= 50, fee) + 0 - 44004.62178853 * 10% = 995,649.537821147
                const bobCollateral = await vault.getFreeCollateral(bob.address)
                expect(bobCollateral).to.be.deep.eq(parseUnits("995649.537821", usdcDecimals))
            })

            it("maker lose money", async () => {
                // alice swap to pay fee
                await marketRegistry.setFeeRatio(baseToken.address, 0.5e6)
                await q2bExactInput(fixture, alice, 100)

                // mock mark price for fixed debt value and position value
                await mockMarkPrice(accountBalance, baseToken.address, "200")

                // bob debt value: 40000 (baseDebt) + 28004.62178853 (quoteDebt) = 68004.62178853
                // bob unrealizedPnl: -15.9536614113
                // as bob has a profit, using accountValue for free collateral
                // free collateral: balance + owedRealizedPnl + pendingFee + pendingFunding + unrealizedPnl - totalMarginRequirement
                // 1000000 + 0 + 50 (fee) + 0 + -15.9536614113 - 68004.62178852765944318 * 10% = 993,233.584159735
                const bobCollateral = await vault.getFreeCollateral(bob.address)
                expect(bobCollateral).to.be.deep.eq(parseUnits("993233.584159", usdcDecimals))
            })
        })
    })

    describe("# getFreeCollateralByToken", async () => {
        describe("without position", async () => {
            beforeEach(async () => {
                mockedWethPriceFeed.smocked.getPrice.will.return.with(parseUnits("3031.39326836", 8))
                mockedWbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("40275.56504427", 8))
            })

            it("weth free collateral equals trader's balance", async () => {
                await deposit(alice, vault, 0.5, weth)
                expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.eq(parseEther("0.5"))
            })

            it("usdc free collateral equals trader's balance", async () => {
                await deposit(alice, vault, 100, usdc)
                expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.eq(
                    parseUnits("100", usdcDecimals),
                )
            })
        })

        describe("settlement token value < 0", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 10, weth)
                // alice position size: 0.651895044478514505
                await q2bExactInput(fixture, alice, 100, baseToken.address)

                // alice has negative pnl
                // mock mark price for fixed debt value and position value
                await mockMarkPrice(accountBalance, baseToken.address, "100")
            })

            // when settlement token value < 0, free collaterals of all collaterals are always 0
            it("free collateral of weth is 0", async () => {
                expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.eq("0")
                expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.eq("0")
            })
        })

        describe("settlement token value >= 0", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 10, weth)
                // alice position size: 0.651895044478514505
                await q2bExactInput(fixture, alice, 100, baseToken.address)
            })

            describe("trader has positive unrealized pnl", async () => {
                beforeEach(async () => {
                    // alice has positive unrealized pnl
                    // mock mark price for fixed debt value and position value
                    await mockMarkPrice(accountBalance, baseToken.address, "200")
                })

                it("deposit only weth, free collateral of weth greater than 0", async () => {
                    // free collateral of weth: ((10 * 3000 * 0.7) - (100 * 10%)) / 3000 / 0.7 = 9.9952381
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(
                        parseEther("9.995238095238095238"),
                    )
                })

                it("deposit weth and wbtc, free collateral of weth/wbtc equal to the balance of weth/wbtc", async () => {
                    await deposit(alice, vault, 1, wbtc)
                    // free collateral of weth: min(((10 * 3000 * 0.7 + 1 * 40000 * 0.7 - 0.000301) - (100 * 10%)) / 3000 / 0.7, 10) = 10
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(parseEther("10"))
                    // free collateral of wbtc: min(((10 * 3000 * 0.7 + 1 * 40000 * 0.7 - 0.000301) - (100 * 10%)) / 40000 / 0.7, 1) = 1
                    expect(await vault.getFreeCollateralByToken(alice.address, wbtc.address)).to.be.eq(
                        parseUnits("1", await wbtc.decimals()),
                    )
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq("0")
                })

                it("weth price drops, free collateral of weth/btc becomes 0", async () => {
                    // free collateral of weth: ((10 * 3000 * 0.7) - (100 * 10%)) / 3000 / 0.7 = 9.9952381
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(
                        parseEther("9.995238095238095238"),
                    )

                    // weth price drops to 1
                    mockedWethPriceFeed.smocked.getPrice.will.return.with(parseUnits("1", 8))

                    // free collateral of weth: max(((10 * 1 * 0.7) - (100 * 10%)) / 1 / 0.7, 0) = 0
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq("0")
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq("0")
                })
            })

            describe("trader has no unrealized pnl", async () => {
                beforeEach(async () => {
                    await deposit(alice, vault, 1, wbtc)
                })

                it("trader's settlement token balance > 0", async () => {
                    // bob long, so alice has positive realized pnl after closing position
                    await q2bExactInput(fixture, bob, 1000, baseToken.address)

                    await closePosition(fixture, alice)

                    const realizedPnL = (await accountBalance.getPnlAndPendingFee(alice.address))[0]

                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(parseEther("10"))
                    expect(await vault.getFreeCollateralByToken(alice.address, wbtc.address)).to.be.eq(
                        parseUnits("1", await wbtc.decimals()),
                    )
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq(
                        realizedPnL.div(10 ** 12),
                    )
                })

                it("trader's settlement token balance < 0", async () => {
                    await mockIndexPrice(mockedPriceFeedDispatcher, "100")
                    await forwardBothTimestamps(clearingHouse, 360)

                    await clearingHouse.connect(alice).settleAllFunding(alice.address)

                    // alice has positive unrealized pnl
                    await mockMarkPrice(accountBalance, baseToken.address, "200")

                    // though settlement token balance < 0, as long as settlement token value > 0, can withdraw other collaterals
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(parseEther("10"))
                    expect(await vault.getFreeCollateralByToken(alice.address, wbtc.address)).to.be.eq(
                        parseUnits("1", await wbtc.decimals()),
                    )
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq("0")
                })
            })

            describe("trader has negative unrealized pnl", async () => {
                beforeEach(async () => {
                    // alice has negative unrealized pnl
                    await mockMarkPrice(accountBalance, baseToken.address, "100")
                })

                it("deposit weth & usdc, free collateral of weth greater than 0", async () => {
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq("0")

                    await deposit(alice, vault, 40, usdc)

                    // unrealized pnl: 0.651895044478514505 * 100 - 100 = -34.81049555
                    // free collateral of weth: ((10 * 3000 * 0.7 + 40 - 34.81049555) - 100 * 10%) / 3000 / 0.7 = 9.9977092878
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.closeTo(
                        parseEther("9.9977092878"),
                        10e8,
                    )
                    // free collateral of usdc: min(10 * 3000 * 0.7 + 40 - 34.81049555 - 100 * 10%, 40) = 40
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq("40000000")
                })
            })
        })
    })
})
