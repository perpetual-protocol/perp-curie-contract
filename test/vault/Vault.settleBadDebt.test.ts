import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    CollateralManager,
    Exchange,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestERC20,
    TestVault,
    UniswapV3Pool,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { mockIndexPrice, syncIndexToMarketPrice, syncMarkPriceToMarketPrice } from "../shared/utilities"

describe("Vault settleBadDebt (assume zero IF fee)", () => {
    const [admin, alice, bob, carol, david] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let vault: TestVault
    let usdc: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let wethPriceFeedDispatcher: MockContract
    let wbtcPriceFeedDispatcher: MockContract
    let insuranceFund: InsuranceFund
    let accountBalance: TestAccountBalance
    let exchange: Exchange
    let orderBook: OrderBook
    let collateralManager: CollateralManager
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedPriceFeedDispatcher: MockContract
    let usdcDecimals: number
    let wbtcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture(true))
        clearingHouse = _fixture.clearingHouse
        vault = _fixture.vault as TestVault
        clearingHouseConfig = _fixture.clearingHouseConfig
        usdc = _fixture.USDC
        weth = _fixture.WETH
        wbtc = _fixture.WBTC
        wethPriceFeedDispatcher = _fixture.mockedWethPriceFeedDispatcher
        wbtcPriceFeedDispatcher = _fixture.mockedWbtcPriceFeedDispatcher
        insuranceFund = _fixture.insuranceFund
        accountBalance = _fixture.accountBalance as TestAccountBalance
        exchange = _fixture.exchange
        orderBook = _fixture.orderBook
        collateralManager = _fixture.collateralManager
        pool = _fixture.pool
        baseToken = _fixture.baseToken
        marketRegistry = _fixture.marketRegistry
        mockedPriceFeedDispatcher = _fixture.mockedPriceFeedDispatcher
        fixture = _fixture

        usdcDecimals = await usdc.decimals()
        wbtcDecimals = await wbtc.decimals()

        await initMarket(fixture, "151.373306858723226652", 10000, 0, 100000, baseToken.address)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)
        await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)

        // mint and add liquidity
        const amount = parseUnits("1000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)

        await mockIndexPrice(wethPriceFeedDispatcher, "3000")
        await mockIndexPrice(wbtcPriceFeedDispatcher, "38583.34253324")

        await weth.mint(alice.address, parseEther("20"))
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.mint(alice.address, parseUnits("1", await wbtc.decimals()))
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

        await usdc.mint(bob.address, parseUnits("1000000", usdcDecimals))
        await deposit(bob, vault, 1000000, usdc)
        await addOrder(fixture, bob, 500, 1000000, 0, 150000)

        // Carol will liquidate Alice's position
        const usdcAmount = parseUnits("10000", usdcDecimals)
        await usdc.mint(carol.address, usdcAmount)
        await usdc.connect(carol).approve(vault.address, usdcAmount)
    })

    describe("settle bad debt", async () => {
        it("forced error when settle insuranceFund badDebt", async () => {
            await expect(vault.settleBadDebt(insuranceFund.address)).to.be.revertedWith("V_CSI")
        })

        it("do not settle unrealized bad debt when user has position", async () => {
            // alice open a long position with 500 USD
            await deposit(alice, vault, 100, usdc)
            await q2bExactInput(fixture, alice, 500)
            // alice has bad debt
            await accountBalance.testModifyOwedRealizedPnl(alice.address, parseEther("-1000"))
            expect(await vault.getAccountValue(alice.address)).to.be.lt("0")

            // do not settle bad debt
            await expect(vault.settleBadDebt(alice.address)).not.emit(vault, "BadDebtSettled")
            expect(await vault.getAccountValue(alice.address)).to.be.lt("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.eq("0")
        })

        it("unrealized bad debt can not be settled when user has non-settlement collateral", async () => {
            // alice deposit non-settlement collateral
            await deposit(alice, vault, 0.1, weth)

            // alice has bad debt
            await accountBalance.testModifyOwedRealizedPnl(alice.address, parseEther("-1000"))
            expect(await vault.getAccountValue(alice.address)).to.be.lt("0")

            // can not settle bad debt when user has non-settlement collateral
            await expect(vault.settleBadDebt(alice.address)).not.emit(vault, "BadDebtSettled")
            expect(await vault.getAccountValue(alice.address)).to.be.lt("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.eq("0")
        })

        it("trader has no bad debt", async () => {
            // alice has no bad debt
            await deposit(alice, vault, 100, usdc)
            expect(await vault.getAccountValue(alice.address)).to.be.gt("0")

            // no need to settle bad debt when user's account value > 0
            await expect(vault.settleBadDebt(alice.address)).not.emit(vault, "BadDebtSettled")
            expect(await vault.getAccountValue(alice.address)).to.be.gt("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.eq("0")
        })

        it("settle trader's bad debt", async () => {
            await accountBalance.testModifyOwedRealizedPnl(alice.address, parseEther("-200"))

            const aliceAccountValue = await vault.getAccountValue(alice.address)
            expect(aliceAccountValue).to.be.eq(parseUnits("-200", usdcDecimals))
            const badDebt = aliceAccountValue.mul("-1")

            await expect(vault.settleBadDebt(alice.address))
                .to.emit(vault, "BadDebtSettled")
                .withArgs(alice.address, badDebt)

            expect(await vault.getAccountValue(alice.address)).to.be.eq("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.eq(aliceAccountValue)
        })
    })
})
