import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    ClearingHouseConfig,
    CollateralManager,
    InsuranceFund,
    MarketRegistry,
    OrderBook,
    TestAccountBalance,
    TestChainlinkPriceFeed,
    TestERC20,
    TestExchange,
    TestVault,
    UniswapV3Pool,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, closePosition, q2bExactInput, removeOrder } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit } from "../helper/token"
import { mockMarkPrice, syncIndexToMarketPrice } from "../shared/utilities"

describe("Sequencer Down", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: ClearingHouse
    let clearingHouseConfig: ClearingHouseConfig
    let vault: TestVault
    let usdc: TestERC20
    let op: TestERC20
    let opPriceFeed: TestChainlinkPriceFeed
    let insuranceFund: InsuranceFund
    let accountBalance: TestAccountBalance
    let exchange: TestExchange
    let orderBook: OrderBook
    let collateralManager: CollateralManager
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let marketRegistry: MarketRegistry
    let mockedPriceFeedDispatcher: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    beforeEach(async () => {
        const _fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = _fixture.clearingHouse
        clearingHouseConfig = _fixture.clearingHouseConfig
        vault = _fixture.vault as TestVault
        usdc = _fixture.USDC
        insuranceFund = _fixture.insuranceFund
        accountBalance = _fixture.accountBalance as TestAccountBalance
        exchange = _fixture.exchange as TestExchange
        orderBook = _fixture.orderBook
        collateralManager = _fixture.collateralManager
        pool = _fixture.pool
        baseToken = _fixture.baseToken
        marketRegistry = _fixture.marketRegistry
        mockedPriceFeedDispatcher = _fixture.mockedPriceFeedDispatcher
        fixture = _fixture

        usdcDecimals = await usdc.decimals()

        // Deploy and add our own non-USDC collateral because we need to customize its ChainlinkPriceFeed,
        // which is not shared in the current fixture.
        const tokenFactory = await ethers.getContractFactory("TestERC20")
        op = (await tokenFactory.deploy()) as TestERC20
        await op.__TestERC20_init("TestOP", "OP", 18)

        const chainlinkPriceFeedFactory = await ethers.getContractFactory("TestChainlinkPriceFeed")
        opPriceFeed = (await chainlinkPriceFeedFactory.deploy()) as TestChainlinkPriceFeed
        await opPriceFeed.setPrice(parseEther("1"))

        await collateralManager.addCollateral(op.address, {
            priceFeed: opPriceFeed.address,
            collateralRatio: (0.7e6).toString(),
            discountRatio: (0.1e6).toString(),
            depositCap: parseEther("10000"),
        })

        // init market and increase price limit
        await initMarket(fixture, "151.373306858723226652", 10000, 0, getMaxTickRange(), baseToken.address)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // alice deposits both USDC and non-USDC collaterals
        const amount = parseUnits("2000", usdcDecimals)
        await usdc.mint(alice.address, amount)
        await usdc.connect(alice).approve(vault.address, amount)
        await deposit(alice, vault, 1000, usdc)

        await op.mint(alice.address, parseEther("3000"))
        await op.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await deposit(alice, vault, 2000, op)

        // bob deposits USDC
        await usdc.mint(bob.address, parseUnits("1000", usdcDecimals))
        await deposit(bob, vault, 1000, usdc)

        // carol adds liquidity
        await usdc.mint(carol.address, parseUnits("10000000", usdcDecimals))
        await deposit(carol, vault, 10000000, usdc)
        await addOrder(fixture, carol, 5000, 10000000, 0, 150000)

        // increase insuranceFund capacity
        await usdc.mint(insuranceFund.address, parseUnits("1000000", 6))
    })

    describe("# sequencer is down", async () => {
        beforeEach(async () => {
            await q2bExactInput(fixture, alice, 5000)
            await q2bExactInput(fixture, bob, 3000)

            await addOrder(fixture, alice, 1, 1000, 0, 150000)
            await addOrder(fixture, bob, 1, 1000, 0, 150000)

            await opPriceFeed.setSequencerStatus(true)
        })

        it("open position", async () => {
            // cannot open position with non-USDC collaterals
            await expect(q2bExactInput(fixture, alice, 100)).to.be.revertedWith("CPF_SD")
            // can open position with only USDC collateral
            await expect(q2bExactInput(fixture, bob, 100)).to.emit(clearingHouse, "PositionChanged")
        })

        it("close position", async () => {
            // cannot close position with non-USDC collaterals
            await expect(closePosition(fixture, alice)).to.be.revertedWith("CPF_SD")
            // can close position with only USDC collateral
            await closePosition(fixture, bob)
        })

        it("withdraw", async () => {
            // cannot withdraw any collateral with non-USDC collaterals
            await expect(vault.connect(alice).withdraw(op.address, parseEther("2000"))).to.revertedWith("CPF_SD")
            await expect(vault.connect(alice).withdraw(usdc.address, parseUnits("100", usdcDecimals))).to.revertedWith(
                "CPF_SD",
            )

            // can withdraw with only USDC collateral
            await vault.connect(bob).withdraw(usdc.address, parseUnits("100", usdcDecimals))
        })

        it("deposit", async () => {
            // can deposit regardless of collateral types because it does not check free collateral and
            // does not need to look up collateral prices.
            await deposit(alice, vault, 100, op)
            await deposit(alice, vault, 100, usdc)

            await op.mint(bob.address, parseEther("3000"))
            await op.connect(bob).approve(vault.address, ethers.constants.MaxUint256)
            await deposit(bob, vault, 100, op)
            await deposit(alice, vault, 100, usdc)
        })

        it("add liquidity", async () => {
            // cannot add liquidity with non-USDC collaterals
            await expect(addOrder(fixture, alice, 1, 1000, 0, 150000)).to.be.revertedWith("CPF_SD")

            // can add liquidity with only USDC collateral
            addOrder(fixture, bob, 1, 1000, 0, 150000)
        })

        it("remove liquidity", async () => {
            // can remove liquidity regardless of collateral types because it does not check free collateral and
            // does not need to look up collateral prices.
            removeOrder(fixture, alice, 1, 0, 150000)
            removeOrder(fixture, bob, 1, 0, 150000)
        })

        it("liquidate with order", async () => {
            await mockMarkPrice(accountBalance, baseToken.address, "5")

            // cannot cancel excess order on account with non-USDC collaterals
            await expect(
                clearingHouse.connect(carol).cancelAllExcessOrders(alice.address, baseToken.address),
            ).to.be.revertedWith("CPF_SD")

            // can cancel excess order and liquidate on account with only-USDC collaterals
            await clearingHouse.connect(carol).cancelAllExcessOrders(bob.address, baseToken.address)
            await clearingHouse.connect(carol)["liquidate(address,address)"](bob.address, baseToken.address)
        })

        it("liquidate without order", async () => {
            // remove alice liquidity
            const aliceMakerLiquidity = (await orderBook.getOpenOrder(alice.address, baseToken.address, 0, 150000))
                .liquidity
            await removeOrder(fixture, alice, aliceMakerLiquidity, 0, 150000, baseToken.address)

            // cannot liquidate account with non-USDC collaterals
            await expect(
                clearingHouse.connect(carol)["liquidate(address,address)"](alice.address, baseToken.address),
            ).to.be.revertedWith("CPF_SD")
        })

        it("liquidate collateral", async () => {
            await mockMarkPrice(accountBalance, baseToken.address, "5")

            await expect(vault.connect(carol).isLiquidatable(alice.address)).to.be.revertedWith("CPF_SD")
            await expect(
                vault.connect(carol).liquidateCollateral(alice.address, op.address, parseEther("1"), true),
            ).to.be.revertedWith("CPF_SD")
        })
    })
})
