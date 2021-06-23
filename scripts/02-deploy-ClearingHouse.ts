import { ethers } from "hardhat"
import { UniswapV3Factory } from "../typechain"

async function main() {
    const tokenFactory = await ethers.getContractFactory("TestERC20")
    const vUSD = await tokenFactory.deploy("vUSD", "vUSD")
    console.log("vUSD deployed to:", vUSD.address)
    const quoteTokenAddr = vUSD.address

    const collateralTokenAddr = "0xf4D2c51c45d0F3Af87Bc597559Fb2703CDBe09fE" // USDC from deploy 01
    const uniswapV3FactoryAddr = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
    const clearingHouseFactory = await ethers.getContractFactory("ClearingHouse")
    const clearingHouse = await clearingHouseFactory.deploy(collateralTokenAddr, quoteTokenAddr, uniswapV3FactoryAddr)
    console.log("ClearingHouse deployed to:", clearingHouse.address)

    const vETH = await tokenFactory.deploy("vETH", "vETH")
    console.log("vETH deployed to:", vETH.address)
    const baseTokenAddr = vETH.address

    await vUSD.setMinter(clearingHouse.address)
    await vETH.setMinter(clearingHouse.address)

    const uniswapV3FactoryFactory = await ethers.getContractFactory("UniswapV3Factory")
    const uniswapV3Factory = uniswapV3FactoryFactory.attach(uniswapV3FactoryAddr) as UniswapV3Factory
    const createPoolTx = await uniswapV3Factory.createPool(baseTokenAddr, quoteTokenAddr, "10000")
    const poolAddr = (await createPoolTx.wait()).events?.[0].args?.pool as string
    console.log("Pool vETH/vUSD deployed to:", poolAddr)

    await clearingHouse.addPool(baseTokenAddr, "10000")
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
