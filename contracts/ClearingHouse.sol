pragma solidity 0.8.4;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";

contract ClearingHouse {
    IERC20 public quoteAsset;
    IERC20 public vQuoteAsset;
    IUniswapV3Factory public uniV3Factory;

    constructor(
        IERC20 vQuoteAssetParam,
        IERC20 quoteAssetParam,
        IUniswapV3Factory uniV3FactoryParam
    ) {
        vQuoteAsset = vQuoteAssetParam;
        quoteAsset = quoteAssetParam;
        uniV3Factory = uniV3FactoryParam;
    }
}
