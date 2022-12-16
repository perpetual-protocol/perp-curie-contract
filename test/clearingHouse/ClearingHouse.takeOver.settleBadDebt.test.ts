import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber } from "ethers"
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
import { b2qExactOutput, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { getMaxTickRange } from "../helper/number"
import { deposit, mintAndDeposit } from "../helper/token"
import { initiateBothTimestamps } from "../shared/time"
import { syncIndexToMarketPrice, syncMarkPriceToMarketPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse liquidate (assume zero IF fee)", () => {
    const [admin, alice, bob, carol, davis] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let million: BigNumber
    let hundred: BigNumber
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let vault: Vault
    let insuranceFund: InsuranceFund
    let collateral: TestERC20
    let weth: TestERC20
    let wbtc: TestERC20
    let mockedWethPriceFeed: MockContract
    let mockedWbtcPriceFeed: MockContract
    let baseToken: BaseToken
    let pool: UniswapV3Pool
    let baseToken2: BaseToken
    let pool2: UniswapV3Pool
    let mockedPriceFeedDispatcher: MockContract
    let mockedPriceFeedDispatcher2: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())

        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        insuranceFund = fixture.insuranceFund
        collateral = fixture.USDC
        weth = fixture.WETH
        wbtc = fixture.WBTC
        baseToken = fixture.baseToken
        pool = fixture.pool
        baseToken2 = fixture.baseToken2
        pool2 = fixture.pool2
        mockedWethPriceFeed = fixture.mockedWethPriceFeed
        mockedWbtcPriceFeed = fixture.mockedWbtcPriceFeed
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        mockedPriceFeedDispatcher2 = fixture.mockedPriceFeedDispatcher2
        collateralDecimals = await collateral.decimals()

        million = parseUnits("1000000", collateralDecimals)
        hundred = parseUnits("100", collateralDecimals)

        // initialize ETH pool
        await initMarket(fixture, "151.3733069", 10000, 0, getMaxTickRange(), baseToken.address)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        // initialize BTC pool
        await initMarket(fixture, "151.3733069", 10000, 0, getMaxTickRange(), baseToken2.address)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher2, pool2)

        // set collateral price
        mockedWethPriceFeed.smocked.getPrice.will.return.with(parseUnits("100", 8))
        mockedWbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("100", 8))

        // mint
        collateral.mint(alice.address, hundred)
        collateral.mint(bob.address, million)
        collateral.mint(carol.address, million)
        await weth.mint(alice.address, parseEther("1"))
        await weth.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
        await wbtc.mint(alice.address, parseEther("1"))
        await wbtc.connect(alice).approve(vault.address, ethers.constants.MaxUint256)

        await deposit(alice, vault, 10, collateral)
        await deposit(bob, vault, 1000000, collateral)
        await deposit(carol, vault, 1000000, collateral)

        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })
        await clearingHouse.connect(carol).addLiquidity({
            baseToken: baseToken2.address,
            base: parseEther("100"),
            quote: parseEther("15000"),
            lowerTick: 49000,
            upperTick: 51400,
            minBase: 0,
            minQuote: 0,
            useTakerBalance: false,
            deadline: ethers.constants.MaxUint256,
        })

        // increase insuranceFund capacity
        await collateral.mint(insuranceFund.address, parseUnits("1000000", 6))

        // mock mark price to make account value calculation easier
        await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)
        await syncMarkPriceToMarketPrice(accountBalance, baseToken2.address, pool2)

        // initiate both the real and mocked timestamps to enable hard-coded funding related numbers
        // NOTE: Should be the last step in beforeEach
        await initiateBothTimestamps(clearingHouse)
    })

    describe("settle bad debt", () => {
        beforeEach(async () => {
            await mintAndDeposit(fixture, admin, 10000)

            // alice long 90 usd
            await q2bExactInput(fixture, alice, 90)

            await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)
            // bob short 12000 usd
            await b2qExactOutput(fixture, bob, 12000)
        })

        it("do not settle bad debt if user has non-settlement collateral after liquidation", async () => {
            await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)

            await deposit(alice, vault, 0.001, weth)

            await expect(
                clearingHouse.connect(admin)["liquidate(address,address)"](alice.address, baseToken.address),
            ).not.emit(vault, "BadDebtSettled")

            expect(await vault.getAccountValue(alice.address)).to.be.lt("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.gte("0")
        })

        it("do not settle bad debt if user still has position after liquidation", async () => {
            await q2bExactInput(fixture, alice, 1, baseToken2.address)

            await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)

            await expect(
                clearingHouse.connect(admin)["liquidate(address,address)"](alice.address, baseToken.address),
            ).not.emit(vault, "BadDebtSettled")

            expect(await vault.getAccountValue(alice.address)).to.be.lt("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.gte("0")
        })

        it("settle bad debt after last liquidation", async () => {
            await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)

            await expect(clearingHouse.connect(admin)["liquidate(address,address)"](alice.address, baseToken.address))
                .to.emit(vault, "BadDebtSettled")
                .withArgs(alice.address, "1081016")

            // liquidatePositionSize: 588407511354640018 = 0.58840751135464
            // indexPrice: 137562058000000010000 = 137.562058
            // exchangedPositionNotional = liquidatePositionSize * indexPrice / 1e18 = 80942548204602648725 = 80.94254820460266
            // liquidationPenalty = exchangedPositionNotional * 0.025 = 2023563705115066218 = 2.023563705115066
            // alice original takeOpenNotional = -90
            // alice original deposit = 10
            // alice after takerOpenNotional = -90 + 80.94254820460266 = -9.057451795397341
            // alice after accountValue = 10 - 9.057451795397341 - 2.023563705115066(fee) = -1.0810155005124074
            // insuranceFund owedRealizedPnl = liquidationPenalty * 0.5 = 1011781852557533000 = 1.011781852557533
            // insuranceFund settlementTokenValue = 1011781852557533000 / 1e12 - 1081016 = -69234.14744246693 => -69235 (round down) = 0.069235
            expect(await vault.getAccountValue(alice.address)).to.be.eq("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.eq("-69235")
            expect(await vault.getBalance(insuranceFund.address)).to.be.eq("-1081016")
        })

        it("settle bad debt after liquidate collateral", async () => {
            // mint usdc to liquidator
            await collateral.mint(admin.address, parseUnits("10000", collateralDecimals))
            await collateral.connect(admin).approve(vault.address, parseUnits("10000", collateralDecimals))

            // alice deposit 0.0001 BTC collateral (1 BTC = 100 U)
            const wbtcDecimal = await wbtc.decimals()
            await vault.connect(alice).deposit(wbtc.address, parseUnits("0.0001", wbtcDecimal))

            await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)

            // not emit event because alice still has wbtc collateral
            await expect(
                clearingHouse.connect(admin)["liquidate(address,address)"](alice.address, baseToken.address),
            ).to.not.emit(vault, "BadDebtSettled")

            // will emit event when liquidate collateral
            await expect(
                vault
                    .connect(admin)
                    .liquidateCollateral(alice.address, wbtc.address, parseUnits("0.0001", wbtcDecimal), false),
            )
                .to.emit(vault, "BadDebtSettled")
                .withArgs(alice.address, "1072286")

            // liquidatePositionSize: 588407511354640018 = 0.58840751135464
            // indexPrice: 137562058000000010000 = 137.562058
            // exchangedPositionNotional = liquidatePositionSize * indexPrice / 1e18 = 80942548204602648725 = 80.94254820460266
            // liquidationPenalty = exchangedPositionNotional * 0.025 = 2023563705115066218 = 2.023563705115066
            // alice original takeOpenNotional = -90
            // alice original deposit = 10
            // alice collateral value = 0.0001 * 100 * 0.7 = 0.007
            // alice after takerOpenNotional = -90 + 80.94254820460266 = -9.057451795397341
            // alice after accountValue = 10 - 9.057451795397341 - 2.023563705115066(fee) + 0.007 (collateral value) = -1.074016
            // insuranceFund liquidate collateral fee = 9000 * 0.03 = 270
            // insuranceFund owedRealizedPnl = liquidationPenalty * 0.5 = 1011781852557533000 = 1.011781852557533
            // insuranceFund settlementTokenValue = 1011781852557533000 / 1e12 - 1072286 + 270 (liquidate collateral fee) = -60234.147442467 => -60235 (round down) = 0.060235
            expect(await vault.getAccountValue(alice.address)).to.be.eq("0")
            expect(await vault.getSettlementTokenValue(insuranceFund.address)).to.be.eq("-60235")
            expect(await vault.getBalance(insuranceFund.address)).to.be.eq("-1072016")
        })
    })
})
