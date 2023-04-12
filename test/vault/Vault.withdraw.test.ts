import { MockContract } from "@eth-optimism/smock"
import { expect } from "chai"
import { BigNumber, Wallet } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import {
    BaseToken,
    ClearingHouse,
    CollateralManager,
    TestAccountBalance,
    TestERC20,
    TestWETH9,
    UniswapV3Pool,
    Vault,
} from "../../typechain"
import { ClearingHouseFixture, createClearingHouseFixture } from "../clearingHouse/fixtures"
import { addOrder, closePosition, q2bExactInput, removeAllOrders } from "../helper/clearingHouseHelper"
import { initMarket } from "../helper/marketHelper"
import { deposit } from "../helper/token"
import { IGNORABLE_DUST } from "../shared/constant"
import { syncIndexToMarketPrice, syncMarkPriceToMarketPrice } from "../shared/utilities"

describe("Vault withdraw test", () => {
    const [admin, alice, bob] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let vault: Vault
    let usdc: TestERC20
    let wbtc: TestERC20
    let weth: TestERC20
    let mockedWbtcPriceFeed: MockContract
    let mockedWethPriceFeed: MockContract
    let clearingHouse: ClearingHouse
    let accountBalance: TestAccountBalance
    let collateralManager: CollateralManager
    let pool: UniswapV3Pool
    let baseToken: BaseToken
    let mockedPriceFeedDispatcher: MockContract
    let usdcDecimals: number
    let fixture: ClearingHouseFixture

    const check = async (user: Wallet, hasAccountValue: boolean, accountValueDust: number = 0) => {
        let freeCollateral: BigNumber
        let accountValue: BigNumber

        // check user
        freeCollateral = await vault.getFreeCollateral(user.address)
        await expect(vault.connect(user).withdrawAll(usdc.address))
            .to.emit(vault, "Withdrawn")
            .withArgs(usdc.address, user.address, freeCollateral)

        freeCollateral = await vault.getFreeCollateral(user.address)
        accountValue = await clearingHouse.getAccountValue(user.address)
        expect(freeCollateral).to.be.eq("0")
        if (!hasAccountValue) {
            expect(accountValue).to.be.closeTo(parseEther("0"), accountValueDust)
        }
        await expect(vault.connect(user).withdraw(usdc.address, "1")).to.be.revertedWith("V_NEFC")
    }

    beforeEach(async () => {
        fixture = await loadFixture(createClearingHouseFixture())
        vault = fixture.vault
        usdc = fixture.USDC
        weth = fixture.WETH
        wbtc = fixture.WBTC
        mockedWethPriceFeed = fixture.mockedWethPriceFeed
        mockedWbtcPriceFeed = fixture.mockedWbtcPriceFeed
        clearingHouse = fixture.clearingHouse
        accountBalance = fixture.accountBalance as TestAccountBalance
        collateralManager = fixture.collateralManager
        pool = fixture.pool
        baseToken = fixture.baseToken
        mockedPriceFeedDispatcher = fixture.mockedPriceFeedDispatcher

        usdcDecimals = await usdc.decimals()

        const initPrice = "151.373306858723226652"
        await initMarket(fixture, initPrice)
        await syncMarkPriceToMarketPrice(accountBalance, baseToken.address, pool)
        await syncIndexToMarketPrice(mockedPriceFeedDispatcher, pool)

        mockedWethPriceFeed.smocked.getPrice.will.return.with(parseUnits("2500", 8))
        mockedWbtcPriceFeed.smocked.getPrice.will.return.with(parseUnits("40000", 8))

        // alice mint collateral tokens
        await usdc.mint(alice.address, parseUnits("100000", usdcDecimals))
        await weth.mint(alice.address, parseEther("200"))
        await wbtc.mint(alice.address, parseUnits("200", await wbtc.decimals()))

        // bob mint and add liquidity
        await usdc.mint(bob.address, parseUnits("10000", usdcDecimals))
    })

    describe("withdraw check", async () => {
        beforeEach(async () => {
            // alice deposit
            await deposit(alice, vault, 10000, usdc)

            // bob deposit and add liquidity
            await deposit(bob, vault, 10000, usdc)
            await addOrder(fixture, bob, 100, 15000, 0, 150000)

            // alice swap
            await q2bExactInput(fixture, alice, 100)
        })

        it("withdraw full freeCollateral after remove liquidity and position", async () => {
            // alice close position
            await closePosition(fixture, alice)

            // bob remove liquidity & close position
            await removeAllOrders(fixture, bob)

            // bob might have dust position
            await check(bob, false, IGNORABLE_DUST)
            await check(alice, false)
        })

        it("withdraw full freeCollateral when user has position", async () => {
            await check(bob, true)
            await check(alice, true)
        })

        it("withdraw full freeCollateral when user has no position", async () => {
            await closePosition(fixture, alice)

            await check(bob, true) // still provide liquidity
            await check(alice, false)
        })

        it("withdraw full freeCollateral when user has position but no liquidity", async () => {
            // bob remove liquidity & close position
            await removeAllOrders(fixture, bob)

            await check(bob, true)
            await check(alice, true)
        })

        it("won't collect fee before withdraw when maker make profit", async () => {
            // alice swap, bob has pending fee
            await q2bExactInput(fixture, alice, 100)
            await closePosition(fixture, alice)

            let pendingFee = (await accountBalance.getPnlAndPendingFee(bob.address))[2]
            expect(pendingFee).to.be.gt(0)

            // maker withdraw
            const freeCollateral = await vault.getFreeCollateral(bob.address)
            await vault.connect(bob).withdraw(usdc.address, freeCollateral)

            // pending fee remains the same
            const pendingFeeAfter = (await accountBalance.getPnlAndPendingFee(bob.address))[2]
            expect(pendingFee).to.be.deep.eq(pendingFeeAfter)
        })
    })

    describe("withdraw settlement token", async () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            await deposit(alice, vault, 100, usdc)
            amount = parseUnits("100", await usdc.decimals())
        })

        it("emit event and update balances", async () => {
            const balanceBefore = await usdc.balanceOf(alice.address)

            await expect(vault.connect(alice).withdraw(usdc.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(usdc.address, alice.address, amount)

            // decrease vault's token balance
            expect(await usdc.balanceOf(vault.address)).to.eq("0")

            const balanceAfter = await usdc.balanceOf(alice.address)
            // sender's token balance increased
            expect(balanceAfter.sub(balanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.eq("0")
        })

        it("force error, freeCollateral is not enough", async () => {
            await expect(
                vault.connect(alice).withdraw(usdc.address, parseUnits("150", await usdc.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })
    })

    describe("withdraw non-settlement token", async () => {
        let amount: ReturnType<typeof parseUnits>
        beforeEach(async () => {
            await deposit(alice, vault, 10, wbtc)
            amount = parseUnits("10", await wbtc.decimals())
        })

        it("emit event and update balances", async () => {
            const balanceBefore = await wbtc.balanceOf(alice.address)

            await expect(vault.connect(alice).withdraw(wbtc.address, amount))
                .to.emit(vault, "Withdrawn")
                .withArgs(wbtc.address, alice.address, amount)

            // decrease vault's token balance
            expect(await wbtc.balanceOf(vault.address)).to.eq("0")

            const balanceAfter = await wbtc.balanceOf(alice.address)
            // sender's token balance increased
            expect(balanceAfter.sub(balanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.eq("0")
        })

        it("deregister collateral after withdraw all balance", async () => {
            const wbtcDecimals = await wbtc.decimals()
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([wbtc.address])

            // withdraw partial of the balance
            await expect(vault.connect(alice).withdraw(wbtc.address, parseUnits("5.5", wbtcDecimals))).to.emit(
                vault,
                "Withdrawn",
            )
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([wbtc.address])

            // withdraw all remaining balance
            await expect(
                vault
                    .connect(alice)
                    .withdraw(wbtc.address, await vault.getFreeCollateralByToken(alice.address, wbtc.address)),
            ).to.emit(vault, "Withdrawn")
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([])
        })

        it("withdraw all non-settlement token", async () => {
            const balanceBefore = await wbtc.balanceOf(alice.address)

            await expect(vault.connect(alice).withdrawAll(wbtc.address))
                .to.emit(vault, "Withdrawn")
                .withArgs(wbtc.address, alice.address, amount)

            // decrease vault's token balance
            expect(await wbtc.balanceOf(vault.address)).to.eq("0")

            const balanceAfter = await wbtc.balanceOf(alice.address)
            // sender's token balance increased
            expect(balanceAfter.sub(balanceBefore)).to.eq(amount)

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.eq("0")

            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([])
        })

        it("force error, freeCollateral is not enough", async () => {
            await expect(
                vault.connect(alice).withdraw(wbtc.address, parseUnits("150", await wbtc.decimals())),
            ).to.be.revertedWith("V_NEFC")
        })

        it("force error, token is not valid non-settlement token", async () => {
            await expect(vault.connect(alice).withdraw(vault.address, "1")).to.be.revertedWith("V_OSCT")
            await expect(vault.connect(alice).withdrawAll(vault.address)).to.be.revertedWith("V_OSCT")
        })
    })

    describe("withdraw ETH", async () => {
        let weth9: TestWETH9
        let amount: BigNumber
        beforeEach(async () => {
            const weth9Factory = await ethers.getContractFactory("TestWETH9")
            weth9 = (await weth9Factory.deploy()) as TestWETH9

            await collateralManager.addCollateral(weth9.address, {
                priceFeed: mockedWethPriceFeed.address,
                collateralRatio: (0.7e6).toString(),
                discountRatio: (0.1e6).toString(),
                depositCap: parseEther("1000"),
            })
            await vault.setWETH9(weth9.address)

            amount = parseEther("300")
            await weth9.connect(alice).deposit({ value: amount })
            await weth9.connect(alice).approve(vault.address, ethers.constants.MaxUint256)
            await vault.connect(alice).deposit(weth9.address, amount)
        })

        it("emit event and update balances", async () => {
            const balanceBefore = await ethers.provider.getBalance(alice.address)

            const tx = await vault.connect(alice).withdrawEther(amount)
            await expect(tx).to.emit(vault, "Withdrawn").withArgs(weth9.address, alice.address, amount)

            // decrease vault's token balance
            expect(await weth9.balanceOf(vault.address)).to.be.eq("0")
            expect(await ethers.provider.getBalance(vault.address)).to.be.eq("0")

            const balanceAfter = await ethers.provider.getBalance(alice.address)
            const txReceipt = await tx.wait()
            const gasUsed = tx.gasPrice.mul(txReceipt.gasUsed)
            // sender's token balance increased
            expect(balanceAfter.sub(balanceBefore)).to.be.eq(amount.sub(gasUsed))

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.be.eq("0")
        })

        it("deregister collateral after withdraw all balance", async () => {
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth9.address])

            // withdraw partial of the balance
            await expect(vault.connect(alice).withdrawEther(parseEther("5.5"))).to.emit(vault, "Withdrawn")
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([weth9.address])

            // withdraw all remaining balance
            await expect(
                vault.connect(alice).withdrawEther(await vault.getFreeCollateralByToken(alice.address, weth9.address)),
            ).to.emit(vault, "Withdrawn")
            expect(await vault.getCollateralTokens(alice.address)).to.be.deep.eq([])
        })

        it("withdraw all", async () => {
            const balanceBefore = await ethers.provider.getBalance(alice.address)

            const tx = await vault.connect(alice).withdrawAllEther()
            await expect(tx).to.emit(vault, "Withdrawn").withArgs(weth9.address, alice.address, amount)

            // decrease vault's token balance
            expect(await weth9.balanceOf(vault.address)).to.be.eq("0")
            expect(await ethers.provider.getBalance(vault.address)).to.be.eq("0")

            const balanceAfter = await ethers.provider.getBalance(alice.address)
            const txReceipt = await tx.wait()
            const gasUsed = tx.gasPrice.mul(txReceipt.gasUsed)
            // sender's token balance increased
            expect(balanceAfter.sub(balanceBefore)).to.be.eq(amount.sub(gasUsed))

            // update sender's balance in vault
            expect(await vault.getBalance(alice.address)).to.be.eq("0")
        })

        it("force error, freeCollateral is not enough", async () => {
            await expect(vault.connect(alice).withdrawEther(parseEther("350"))).to.be.revertedWith("V_NEFC")
        })

        it("force error, ETH is not collateral", async () => {
            await vault.setWETH9(pool.address)

            await expect(vault.connect(alice).withdrawEther(parseEther("10"))).to.be.revertedWith("V_WINAC")
            await expect(vault.connect(alice).withdrawAllEther()).to.be.revertedWith("V_WINAC")
        })
    })
})
