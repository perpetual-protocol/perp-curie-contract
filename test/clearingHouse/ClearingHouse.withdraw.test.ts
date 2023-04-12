import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, TestAccountBalance, TestClearingHouse, TestERC20, Vault } from "../../typechain"
import { b2qExactInput, closePosition, q2bExactInput } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { encodePriceSqrt, mockIndexPrice, mockMarkPrice } from "../shared/utilities"
import { ClearingHouseFixture, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse withdraw", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let fixture: ClearingHouseFixture
    let clearingHouse: TestClearingHouse
    let accountBalance: TestAccountBalance
    let vault: Vault
    let collateral: TestERC20
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let collateralDecimals: number

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        clearingHouse = fixture.clearingHouse as TestClearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        vault = fixture.vault
        collateral = fixture.USDC
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher
        collateralDecimals = await collateral.decimals()

        const initPrice = "151.3733069"
        await initMarket(fixture, initPrice, undefined, 0)
        await mockIndexPrice(mockedPriceFeedDispatcher, "151")
    })

    describe("# withdraw with maker fee", () => {
        const lowerTick = 50000 // 148.3760629
        const upperTick = 50200 // 151.3733069

        beforeEach(async () => {
            // mint
            collateral.mint(alice.address, parseUnits("100", collateralDecimals))

            // prepare collateral for alice
            await deposit(alice, vault, 100, collateral)

            // mint vToken
            const quoteAmount = parseEther("0.122414646")

            // alice add liquidity
            const addLiquidityParams = {
                baseToken: baseToken.address,
                base: 0,
                quote: quoteAmount,
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            }
            // will mint 0.122414646 quote and transfer to pool
            await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)
        })

        it("taker swap and then withdraw maker's free collateral", async () => {
            // mock mark price to make free collateral easier
            await mockMarkPrice(accountBalance, baseToken.address, "100")
            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)

            // bob swap
            // base: 0.0004084104205
            // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334176 quote
            // bob gets 0.06151334176 * 0.99 = 0.06089820834
            // will mint 0.0004084104205 base and transfer to pool
            // will receive 0.06151334176 quote from pool
            await clearingHouse.connect(bob).swap({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseEther("0.0004084104205"),
                sqrtPriceLimitX96: "0",
            })

            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue) * imRatio, 0)
            //                  = max(min(100, 100+) - max(0.0004084104205 * 100, 0.0004084104205 * 100 + 0) * 0.1, 0)
            //                  = 99.9959158958
            expect(await vault.getFreeCollateral(bob.address)).to.eq(parseUnits("99.995915", collateralDecimals))
            await expect(vault.connect(bob).withdraw(collateral.address, parseUnits("99.995915", collateralDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, parseUnits("99.995915", collateralDecimals))
            expect(await collateral.balanceOf(bob.address)).to.eq(parseUnits("99.995915", collateralDecimals))
            expect(await vault.getBalance(bob.address)).to.eq(parseUnits("0.004085", collateralDecimals))

            // alice remove liq 0, alice should collect fee
            // B2QFee: expect 1% of quote = 0.0006151334176 ~= 615133417572501 / 10^18
            // will receive and burn base and quote tokens (uniswap fees)
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // verify maker's free collateral should include collected fee
            // collateral = 100 + 0.0006151334176 = 100.0006151334176, base debt = 0, quote debt = 0.122414646
            // maker.quoteInPool -= 0.06151334176
            // maker.baseInPool += 0.0004084104205
            // maker.unrealizedPnl = positionValue + openNotional
            //                     = 0.0004084104205 * 100 + (-0.06151334176)
            //                     = -0.02067229971
            //
            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue) * imRatio, 0)
            //                  = max(min(100.0006151334176, 100.0006151334176 - 0.02067229971) - max(0.0004084104205 * 100, 0.122414646) * 0.1, 0)
            //                  = 99.9677005354
            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("99.967701", collateralDecimals))

            // alice can withdraw free collateral even she has liquidity in pool.
            await expect(vault.connect(alice).withdraw(collateral.address, parseUnits("99.967701", collateralDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, parseUnits("99.967701", collateralDecimals))
        })

        it("taker swap and then withdraw maker's fee without removing liquidity", async () => {
            // add Alice's max liquidity
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: 0,
                quote: parseEther((1000 - 0.122415).toString()),
                lowerTick, // 148.3760629
                upperTick, // 151.3733069
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            // prepare collateral for bob
            await collateral.mint(bob.address, parseUnits("100", collateralDecimals))
            await deposit(bob, vault, 100, collateral)

            // bob short
            // specific quote (qs): 0.01
            // returned base (br): 0.000672815142131486
            // B2QFee: CH actually shorts with quote 0.1 / 0.99 = 0.101010101 (exact output) and alice get 0.00101010101 fee
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("0.1"),
                sqrtPriceLimitX96: 0,
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // bob long 0.000672815142131485 eth to clear position
            // specific base (bs): 0.000672815142131485
            // returned quote (qr): 0.102030405060708093
            // Q2BFee: CH actually long with quote 0.102030405060708093 and alice get 0.00102030405060708093 fee
            await clearingHouse.connect(bob).openPosition({
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: false,
                oppositeAmountBound: 0,
                amount: parseEther("0.000672815142131485"),
                sqrtPriceLimitX96: encodePriceSqrt(152, 1),
                deadline: ethers.constants.MaxUint256,
                referralCode: ethers.constants.HashZero,
            })

            // alice remove liq 0, and collect fee to collateral
            // B2QFee: 0.00101010101010101010
            // Q2BFee: 0.00102030405060708093
            // total fee: 0.002030405
            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick,
                upperTick,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })

            // verify maker's free collateral should include collected fee
            // collateral = 100 + 0.002030405 = 100.002030405, base debt = 0, quote debt = 0.122414646
            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(quoteDebtValue + totalBaseDebtValue) * imRatio, 0)
            //                  = max(min(100.002030405, 100.002030405) - max(1000 + 0) * 0.1, 0)
            //                  = 0.00203

            expect(await vault.getFreeCollateral(alice.address)).to.eq(parseUnits("0.00203", collateralDecimals))
            // alice can withdraw free collateral even she has liquidity in pool.
            await expect(vault.connect(alice).withdraw(collateral.address, parseUnits("0.00203", collateralDecimals)))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, parseUnits("0.00203", collateralDecimals))
        })
    })

    describe("# withdraw", () => {
        beforeEach(async () => {
            await collateral.mint(alice.address, parseUnits("20000", collateralDecimals))
            await deposit(alice, vault, 20000, collateral)
            const collateralAmount = parseUnits("1000", collateralDecimals)
            await collateral.mint(bob.address, collateralAmount)
            await deposit(bob, vault, 1000, collateral)

            // alice the maker add liq. first
            // will mint x base and y quote and transfer to pool
            await clearingHouse.connect(alice).addLiquidity({
                baseToken: baseToken.address,
                base: parseUnits("500"),
                quote: parseUnits("50000"),
                lowerTick: 50000,
                upperTick: 50400,
                minBase: 0,
                minQuote: 0,
                useTakerBalance: false,
                deadline: ethers.constants.MaxUint256,
            })

            const [baseBalance, quoteBalance] = await clearingHouse.getTokenBalance(alice.address, baseToken.address)

            expect(baseBalance).to.eq(parseEther("-330.309218099849988845"))
            expect(quoteBalance).to.eq(parseEther("-50000"))
        })

        it("taker do nothing and then withdraw", async () => {
            const amount = parseUnits("1000", collateralDecimals)
            expect(await vault.getFreeCollateral(bob.address)).to.eq(amount)

            await expect(vault.connect(bob).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, bob.address, amount)
            expect(await collateral.balanceOf(bob.address)).to.eq(amount)
            expect(await vault.getBalance(bob.address)).to.eq("0")
        })

        it("maker withdraw after adding liquidity", async () => {
            // mock mark price to make free collateral easier
            await mockMarkPrice(accountBalance, baseToken.address, "100")
            // free collateral = max(min(collateral, accountValue) - imReq, 0)
            //                 = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue) * imRatio, 0)
            //                 = max(min(20000, 20000) - max(0, 330.3092180998 * 100 + 50000) * 0.1, 0)
            //                 = 11696.907819002
            const amount = parseUnits("11696.907819", collateralDecimals)
            expect(await vault.getFreeCollateral(alice.address)).to.eq(amount)

            await expect(vault.connect(alice).withdraw(collateral.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, amount)
            expect(await collateral.balanceOf(alice.address)).to.eq(amount)
            // 20000 - 11696.907819 = 8303.092181
            expect(await vault.getBalance(alice.address)).to.eq(parseUnits("8303.092181", collateralDecimals))
        })

        it("taker withdraw exactly freeCollateral when owedRealizedPnl < 0", async () => {
            await q2bExactInput(fixture, bob, 100)
            await b2qExactInput(fixture, alice, 0.1)
            await closePosition(fixture, bob)

            const [owedRealizedPnl] = await accountBalance.getPnlAndPendingFee(bob.address)
            expect(owedRealizedPnl).to.lt(0)
            const freeCollateral = await vault.getFreeCollateral(bob.address)
            await expect(vault.connect(bob).withdraw(fixture.USDC.address, freeCollateral)).not.reverted
        })

        it("taker withdraw exactly freeCollateral when owedRealizedPnl > 0", async () => {
            await b2qExactInput(fixture, bob, 1)

            await clearingHouse.connect(alice).removeLiquidity({
                baseToken: baseToken.address,
                lowerTick: 50000,
                upperTick: 50400,
                liquidity: "0",
                minBase: 0,
                minQuote: 0,
                deadline: ethers.constants.MaxUint256,
            })
            const [owedRealizedPnl] = await accountBalance.getPnlAndPendingFee(alice.address)
            expect(owedRealizedPnl).to.gt(0)

            const freeCollateral = await vault.getFreeCollateral(alice.address)
            expect(await vault.connect(alice).withdraw(collateral.address, freeCollateral))
                .to.emit(vault, "Withdrawn")
                .withArgs(collateral.address, alice.address, freeCollateral)
        })

        it("force error, withdraw without deposit", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, parseUnits("1000", collateralDecimals)),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, margin requirement is larger than accountValue", async () => {
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseUnits("10000"),
                sqrtPriceLimitX96: 0,
            })

            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue) * imRatio, 0)
            //                  = max(min(1000, 1000 - loss) - max(10000 - loss, 10000 + 0) * 0.1, 0)
            //                  = 0
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, parseUnits("1000", collateralDecimals)),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, margin requirement is larger than collateral", async () => {
            await clearingHouse.connect(bob).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseUnits("100"),
                sqrtPriceLimitX96: 0,
            })

            // carol open a short position to make price goes down.
            // So that Bob has profit
            const collateralAmount = parseUnits("1000", collateralDecimals)
            await collateral.mint(carol.address, collateralAmount)
            await deposit(carol, vault, 1000, collateral)
            await clearingHouse.connect(carol).swap({
                // sell base
                baseToken: baseToken.address,
                isBaseToQuote: true,
                isExactInput: true,
                amount: parseUnits("1"),
                sqrtPriceLimitX96: 0,
            })

            // mock mark price to make free collateral easier
            await mockMarkPrice(accountBalance, baseToken.address, "110")

            // conservative config:
            //   freeCollateral = max(min(collateral, accountValue) - imReq, 0)
            //                  = max(min(collateral, accountValue) - max(totalAbsPositionValue, quoteDebtValue + totalBaseDebtValue) * imRatio, 0)
            //                  = max(min(1000, 1000 + profit) - max(100 * 110, 100 * 110 + 0) * 0.1, 0)
            //                  = 0
            expect(await vault.getFreeCollateral(bob.address)).to.eq("0")
            await expect(
                vault.connect(bob).withdraw(collateral.address, parseUnits("1000", collateralDecimals)),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, withdrawal amount is more than collateral", async () => {
            await expect(
                vault.connect(carol).withdraw(collateral.address, parseUnits("5000", collateralDecimals)),
            ).to.be.revertedWith("V_NEFC")
        })

        // conservative and moderate config's freeCollateral are both bounded by user collateral,
        // so they are not susceptible to broken index prices;
        // however, as of 2021.08.25, aggressive config's freeCollateral depends entirely on the index price.
        // Therefore, we should implement an anomaly check before using the config.
        // The following test would fail without the said anomaly check.
        it("force error, free collateral should not depend solely on index price", async () => {
            await clearingHouse.connect(bob).swap({
                // buy base
                baseToken: baseToken.address,
                isBaseToQuote: false,
                isExactInput: true,
                amount: parseUnits("10000"),
                sqrtPriceLimitX96: 0,
            })

            // simulate broken price oracle
            await mockMarkPrice(accountBalance, baseToken.address, "999999999")

            // 65.2726375819(positionSize) * 999999999 = 65,272,637,516.627365 > 50,000,000,000
            expect(await vault.getFreeCollateral(bob.address)).to.lt(parseUnits("50000000000", collateralDecimals))
        })
    })
})
