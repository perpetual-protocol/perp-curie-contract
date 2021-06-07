pragma solidity 0.8.4;
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IUniswapV3Factory } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Factory.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { UniswapV3Broker } from "./lib/UniswapV3Broker.sol";

contract ClearingHouse is Ownable {
    //
    // events
    //
    event PoolAdded(address pool);

    //
    // state variables
    //
    IERC20 public quoteAsset;
    IERC20 public vQuoteAsset;
    IUniswapV3Factory public uniV3Factory;

    mapping(IUniswapV3Pool => bool) poolMap;

    constructor(
        IERC20 vQuoteAssetParam,
        IERC20 quoteAssetParam,
        IUniswapV3Factory uniV3FactoryParam
    ) {
        vQuoteAsset = vQuoteAssetParam;
        quoteAsset = quoteAssetParam;
        uniV3Factory = uniV3FactoryParam;
    }

    function addPool(IUniswapV3Pool pool) external onlyOwner {
        // CH_EP: existent pool in ClearingHouse
        require(!poolMap[pool], "CH_EP");
        // CH_NEP: non-existent pool in uniV3 factory
        require(UniswapV3Broker.isExistedPool(address(uniV3Factory), address(pool)), "CH_NEP");

        // update poolMap
        poolMap[pool] = true;

        emit PoolAdded(address(pool));
    }
}
