import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    AccountBalance,
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    CollateralManager,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    TestAccountBalance,
    TestERC20,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initAndAddPool } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { forward } from "../shared/time"
import { encodePriceSqrt } from "../shared/utilities"

describe("Vault getFreeCollateral", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let wethPriceFeed: MockContract
    let wbtcPriceFeed: MockContract
    let clearingHouse: ClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let insuranceFund: InsuranceFund
    let accountBalance: AccountBalance | TestAccountBalance
    let exchange: Exchange
    let collateralManager: CollateralManager
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedBaseAggregator: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture(false))
        vault = fixture.vault
        usdc = fixture.USDC
        weth = fixture.WETH
        wbtc = fixture.WBTC
        wethPriceFeed = fixture.mockedWethPriceFeed
        wbtcPriceFeed = fixture.mockedWbtcPriceFeed
        clearingHouse = fixture.clearingHouse
        clearingHouseConfig = fixture.clearingHouseConfig
        insuranceFund = fixture.insuranceFund
        accountBalance = fixture.accountBalance
        exchange = fixture.exchange
        collateralManager = fixture.collateralManager
        pool = fixture.pool
        baseToken = fixture.baseToken
        marketRegistry = fixture.marketRegistry
        mockedBaseAggregator = fixture.mockedBaseAggregator
        fixture = fixture

        usdcDecimals = await usdc.decimals()

        await initAndAddPool(
            fixture,
            pool,
            baseToken.address,
            encodePriceSqrt("151.373306858723226652", "1"), // tick = 50200 (1.0001^50200 = 151.373306858723226652)
            10000,
            1000,
        )

        mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
            return [0, parseUnits("151", 6), 0, 0, 0]
        })

        // mint and add liquidity
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        wethPriceFeed.smocked.getPrice.will.return.with(parseEther("3000"))
        wbtcPriceFeed.smocked.getPrice.will.return.with(parseEther("40000"))
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
    })

    describe("# getFreeCollateral", async () => {
        describe("freeCollateral should include funding payment", () => {
            beforeEach(async () => {
                const amount = parseUnits("100", usdcDecimals)
                await vault.connect(alice).deposit(usdc.address, amount)
            })

            it("long then get free collateral", async () => {
                // set index price for a positive funding
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("150", 6), 0, 0, 0]
                })

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

                // openNotional = -10
                // positionValue = 0.065379992856491801 * 150 = 9.8069989285
                // unrealizedPnL = 9.8069989285 -10 = -0.1930010715
                // freeCollateral = min(collateral, accountValue) - totalDebt * imRatio
                //                = min(100, 100-0.1930010715) - 10*0.1
                //                = 98.806998

                await forward(3600)

                // alice should pay funding payment
                // note that bob will settle his pending funding payment here

                // fundingPayment = positionSize * pricePremium * 3600 / (24 * 3600)
                //                = 0.065379992856491801 * (151.4641535519 - 150) * 3600 / (24 * 3600)
                //                = 0.00398859786
                // freeCollateral = 98.806998 - 0.00398859786
                //                = 98.803009

                const freeCollateral = (await vault.getFreeCollateral(alice.address)).toString()
                expect(freeCollateral).to.be.eq(parseUnits("98.803011", usdcDecimals))
            })
        })

        describe("freeCollateral should include pending maker fee", async () => {
            beforeEach(async () => {
                const amount = parseUnits("1000", usdcDecimals)
                await vault.connect(alice).deposit(usdc.address, amount)
            })

            it("maker make profit", async () => {
                // alice swap to pay fee
                await marketRegistry.setFeeRatio(baseToken.address, 0.5e6)
                await q2bExactInput(fixture, alice, 100)

                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("80", 6), 0, 0, 0]
                })

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

                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("200", 6), 0, 0, 0]
                })

                // bob debt value: 40000 (baseDebt) + 28004.62178853 (quoteDebt) = 68004.62178853
                // bob unrealizedPnl: -15.9536614113
                // as bob has a profit, using accountValue for free collateral
                // free collateral: balance + owedRealizedPnl + pendingFee + pendingFunding + unrealizedPnl - totalMarginRequirement
                // 1000000 + 0 + 50 (fee) + 0 + -15.9536614113 - 68004.62178852765944318 * 10% = 993,233.584159735
                const bobCollateral = await vault.getFreeCollateral(bob.address)
                expect(bobCollateral).to.be.deep.eq(parseUnits("993233.584160", usdcDecimals))
            })
        })
    })

    describe("# getFreeCollateralByToken", async () => {
        describe("without position", async () => {
            it("free collateral equals trader's balance", async () => {
                await deposit(alice, vault, 10, weth)
                await deposit(alice, vault, 1, wbtc)
                await deposit(alice, vault, 1000, usdc)
                expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.eq(parseEther("10"))
                expect(await vault.getFreeCollateralByToken(alice.address, wbtc.address)).to.eq(
                    parseUnits("1", await wbtc.decimals()),
                )
                expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.eq(
                    parseUnits("1000", usdcDecimals),
                )
            })
        })

        describe("settlement token value < 0", async () => {
            beforeEach(async () => {
                await deposit(alice, vault, 10, weth)
                // alice position size: 0.651895044478514505
                await q2bExactInput(fixture, alice, 100, baseToken.address)
                // alice has negative pnl
                mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                    return [0, parseUnits("100", 6), 0, 0, 0]
                })
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
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("200", 6), 0, 0, 0]
                    })
                })

                it("deposit only weth, free collateral of weth greater than 0", async () => {
                    // free collateral of weth: ((10 * 3000 * 0.7) - (100 * 10%)) / 3000 / 0.7 = 9.9952381
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(
                        parseEther("9.995238095238095238"),
                    )
                })

                it("deposit weth and wbtc, free collateral of weth/wbtc equal to the balance of weth/wbtc", async () => {
                    await deposit(alice, vault, 1, wbtc)
                    // pending funding payment: -0.000301803261332645 ->  -0.000301
                    // free collateral of weth: min(((10 * 3000 * 0.7 + 1 * 40000 * 0.7 - 0.000301) - (100 * 10%)) / 3000 / 0.7, 10) = 10
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(parseEther("10"))
                    // free collateral of wbtc: min(((10 * 3000 * 0.7 + 1 * 40000 * 0.7 - 0.000301) - (100 * 10%)) / 40000 / 0.7, 1) = 1
                    expect(await vault.getFreeCollateralByToken(alice.address, wbtc.address)).to.be.eq(
                        parseUnits("1", await wbtc.decimals()),
                    )
                    // free collateral of usdc: 0.000301
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq("301")
                })

                it("weth price drops, free collateral of weth/btc becomes 0", async () => {
                    // free collateral of weth: ((10 * 3000 * 0.7) - (100 * 10%)) / 3000 / 0.7 = 9.9952381
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(
                        parseEther("9.995238095238095238"),
                    )

                    // weth price drops to 1
                    wethPriceFeed.smocked.getPrice.will.return.with(parseEther("1"))

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
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("100", 6), 0, 0, 0]
                    })
                    await forward(360)

                    await clearingHouse.connect(alice).settleAllFunding(alice.address)

                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("200", 6), 0, 0, 0]
                    })

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
                    mockedBaseAggregator.smocked.latestRoundData.will.return.with(async () => {
                        return [0, parseUnits("100", 6), 0, 0, 0]
                    })
                })

                it("deposit weth & usdc, free collateral of weth greater than 0", async () => {
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq("0")

                    await deposit(alice, vault, 40, usdc)

                    // unrealized pnl: 0.651895044478514505 * 100 - 100 = -34.81049555
                    // pending funding payment: 0.0001509
                    // free collateral of weth: ((10 * 3000 * 0.7 + 40 - 34.81049555 - 0.0001509) - 100 * 10%) / 3000 / 0.7 = 9.99770922
                    expect(await vault.getFreeCollateralByToken(alice.address, weth.address)).to.be.eq(
                        parseEther("9.997709216666666667"),
                    )
                    // free collateral of usdc: min(10 * 3000 * 0.7 + 40 - 34.81049555 - 0.0001509 - 100 * 10%, 40 - 0.0001509) = 39.9998491
                    expect(await vault.getFreeCollateralByToken(alice.address, usdc.address)).to.be.eq("39999850")
                })
            })
        })
    })
})
